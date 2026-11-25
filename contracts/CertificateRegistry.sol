// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title CertificateRegistry
 * @dev NOSIH — blockchain-anchored academic/professional certificates.
 *
 * Design notes
 * - Only hashes and pseudonymous identifiers live on-chain. Holder names,
 *   identifiers, grades and full metadata stay in access-controlled Supabase.
 * - Every issuer wallet is bound to ONE institution identity hash. The
 *   institution supplied at issuance must match that binding, so an issuer
 *   from Institution A can never issue on behalf of Institution B.
 * - Revocation stores only a reason hash; the human-readable reason lives in
 *   the private audit trail off-chain.
 * - Reissuance never overwrites: a corrected certificate gets a new ID and
 *   points at the certificate it supersedes.
 * - Expiry is informational on-chain (0 = no expiry); verdicts compute
 *   expired = expiresAt != 0 && block.timestamp > expiresAt at read time.
 */
contract CertificateRegistry is AccessControl, ReentrancyGuard {
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant REVOKER_ROLE = keccak256("REVOKER_ROLE");

    struct Certificate {
        bytes32 certificateIdHash;          // keccak256("CERT-XXXXXXXX")
        bytes32 institutionIdHash;          // HMAC pseudonym of the institution
        bytes32 holderIdentityHash;         // HMAC pseudonym of the holder
        bytes32 documentHash;               // SHA-256 of the exact certificate PDF
        bytes32 metadataHash;               // SHA-256 of canonical approved metadata
        string  ipfsCID;                    // CID of the ENCRYPTED certificate
        address issuer;                     // recorded from msg.sender
        uint64  issuedAt;                   // block.timestamp at issuance
        uint64  expiresAt;                  // 0 = does not expire
        bool    revoked;
        bool    exists;
        bytes32 supersedesCertificateIdHash; // reissuance link (0 = original)
    }

    mapping(bytes32 => Certificate) private certificates;
    mapping(address => bytes32) private issuerInstitution;
    mapping(bytes32 => bytes32) public revocationReasonHash;

    event IssuerAuthorized(address indexed issuer, bytes32 indexed institutionIdHash);
    event IssuerRemoved(address indexed issuer, bytes32 indexed institutionIdHash);
    event CertificateIssued(
        bytes32 indexed certificateIdHash,
        bytes32 indexed institutionIdHash,
        address indexed issuer,
        bytes32 documentHash,
        bytes32 metadataHash,
        bytes32 supersedesCertificateIdHash,
        string ipfsCID,
        uint64 issuedAt,
        uint64 expiresAt
    );
    event CertificateRevoked(
        bytes32 indexed certificateIdHash,
        address indexed revokedBy,
        bytes32 reasonHash
    );

    constructor() {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    // ─────────────────────────────────────────────
    //  ISSUER AUTHORIZATION (platform admin)
    // ─────────────────────────────────────────────

    /**
     * @notice Binds an issuer wallet to an institution and grants ISSUER_ROLE.
     * @dev Off-chain, the backend only calls this for APPROVED institutions.
     */
    function authorizeIssuer(address issuer, bytes32 institutionIdHash)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        require(issuer != address(0), "NOSIH: zero issuer address");
        require(institutionIdHash != bytes32(0), "NOSIH: empty institution identity");
        require(issuerInstitution[issuer] == bytes32(0), "NOSIH: issuer already authorized");
        issuerInstitution[issuer] = institutionIdHash;
        _grantRole(ISSUER_ROLE, issuer);
        emit IssuerAuthorized(issuer, institutionIdHash);
    }

    function removeIssuer(address issuer) external onlyRole(DEFAULT_ADMIN_ROLE) {
        bytes32 institutionIdHash = issuerInstitution[issuer];
        require(institutionIdHash != bytes32(0), "NOSIH: issuer not authorized");
        delete issuerInstitution[issuer];
        _revokeRole(ISSUER_ROLE, issuer);
        emit IssuerRemoved(issuer, institutionIdHash);
    }

    // ─────────────────────────────────────────────
    //  ISSUANCE (institution-bound issuer wallets)
    // ─────────────────────────────────────────────

    /**
     * @notice Registers a certificate. Caller-supplied issuer/issuedAt/revoked/
     *         exists are ignored: the contract stamps them itself.
     */
    function issueCertificate(Certificate calldata cert)
        external
        onlyRole(ISSUER_ROLE)
        nonReentrant
    {
        bytes32 boundInstitution = issuerInstitution[msg.sender];
        require(boundInstitution != bytes32(0), "NOSIH: issuer not bound");
        require(cert.institutionIdHash == boundInstitution, "NOSIH: institution mismatch");
        require(cert.certificateIdHash != bytes32(0), "NOSIH: empty certificateIdHash");
        require(cert.holderIdentityHash != bytes32(0), "NOSIH: empty holderIdentityHash");
        require(cert.documentHash != bytes32(0), "NOSIH: empty documentHash");
        require(cert.metadataHash != bytes32(0), "NOSIH: empty metadataHash");
        require(bytes(cert.ipfsCID).length > 0, "NOSIH: empty CID");
        require(!certificates[cert.certificateIdHash].exists, "NOSIH: certificate exists");
        if (cert.supersedesCertificateIdHash != bytes32(0)) {
            require(
                certificates[cert.supersedesCertificateIdHash].exists,
                "NOSIH: supersedes unknown certificate"
            );
        }
        if (cert.expiresAt != 0) {
            require(cert.expiresAt > block.timestamp, "NOSIH: expiry in the past");
        }

        Certificate storage s = certificates[cert.certificateIdHash];
        s.certificateIdHash = cert.certificateIdHash;
        s.institutionIdHash = cert.institutionIdHash;
        s.holderIdentityHash = cert.holderIdentityHash;
        s.documentHash = cert.documentHash;
        s.metadataHash = cert.metadataHash;
        s.ipfsCID = cert.ipfsCID;
        s.issuer = msg.sender;
        s.issuedAt = uint64(block.timestamp);
        s.expiresAt = cert.expiresAt;
        s.revoked = false;
        s.exists = true;
        s.supersedesCertificateIdHash = cert.supersedesCertificateIdHash;

        emit CertificateIssued(
            cert.certificateIdHash,
            cert.institutionIdHash,
            msg.sender,
            cert.documentHash,
            cert.metadataHash,
            cert.supersedesCertificateIdHash,
            cert.ipfsCID,
            s.issuedAt,
            cert.expiresAt
        );
    }

    // ─────────────────────────────────────────────
    //  REVOCATION (dedicated revocation key)
    // ─────────────────────────────────────────────

    /**
     * @notice Permanent, auditable revocation. Only the reason HASH is stored;
     *         the explanation lives in the private off-chain audit trail.
     */
    function revokeCertificate(bytes32 certificateIdHash, bytes32 reasonHash)
        external
        onlyRole(REVOKER_ROLE)
        nonReentrant
    {
        Certificate storage s = certificates[certificateIdHash];
        require(s.exists, "NOSIH: certificate not found");
        require(!s.revoked, "NOSIH: already revoked");
        require(reasonHash != bytes32(0), "NOSIH: reason hash required");
        s.revoked = true;
        revocationReasonHash[certificateIdHash] = reasonHash;
        emit CertificateRevoked(certificateIdHash, msg.sender, reasonHash);
    }

    // ─────────────────────────────────────────────
    //  READ (free)
    // ─────────────────────────────────────────────

    function getCertificate(bytes32 certificateIdHash)
        external
        view
        returns (Certificate memory)
    {
        require(certificates[certificateIdHash].exists, "NOSIH: certificate not found");
        return certificates[certificateIdHash];
    }

    function certificateExists(bytes32 certificateIdHash) external view returns (bool) {
        return certificates[certificateIdHash].exists;
    }

    function getIssuerInstitution(address issuer) external view returns (bytes32) {
        return issuerInstitution[issuer];
    }
}