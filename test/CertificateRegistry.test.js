const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const INST_A = id("INST-AAAAAAAA");
const INST_B = id("INST-BBBBBBBB");

function cert(overrides = {}) {
  return {
    certificateIdHash: id("CERT-8A91F203"),
    institutionIdHash: INST_A,
    holderIdentityHash: id("holder-1"),
    documentHash: id("doc-1"),
    metadataHash: id("meta-1"),
    ipfsCID: "bafyTestCid",
    issuer: ethers.ZeroAddress, // contract must overwrite with msg.sender
    issuedAt: 0, // contract must overwrite with block.timestamp
    expiresAt: 0,
    revoked: false,
    exists: false,
    supersedesCertificateIdHash: ethers.ZeroHash,
    ...overrides,
  };
}

describe("CertificateRegistry", () => {
  let registry, admin, issuerA, issuerB, revoker, stranger;
  let ADMIN_ROLE, ISSUER_ROLE, REVOKER_ROLE;

  beforeEach(async () => {
    [admin, issuerA, issuerB, revoker, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("CertificateRegistry")).deploy();
    ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
    ISSUER_ROLE = await registry.ISSUER_ROLE();
    REVOKER_ROLE = await registry.REVOKER_ROLE();
    await registry.authorizeIssuer(issuerA.address, INST_A);
    await registry.authorizeIssuer(issuerB.address, INST_B);
    await registry.grantRole(REVOKER_ROLE, revoker.address);
  });

  // 1. Contract deployment
  it("deploys with the platform admin holding DEFAULT_ADMIN_ROLE", async () => {
    expect(await registry.hasRole(ADMIN_ROLE, admin.address)).to.equal(true);
    expect(await registry.hasRole(ADMIN_ROLE, stranger.address)).to.equal(false);
    expect(await registry.hasRole(ISSUER_ROLE, admin.address)).to.equal(false);
    expect(await registry.hasRole(REVOKER_ROLE, admin.address)).to.equal(false);
    expect(ISSUER_ROLE).to.equal(id("ISSUER_ROLE"));
    expect(REVOKER_ROLE).to.equal(id("REVOKER_ROLE"));
  });

  // 2. Admin role
  it("restricts administration to the platform admin", async () => {
    await expect(
      registry.connect(stranger).authorizeIssuer(stranger.address, INST_A)
    ).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, ADMIN_ROLE);
    await registry.grantRole(REVOKER_ROLE, stranger.address);
    expect(await registry.hasRole(REVOKER_ROLE, stranger.address)).to.equal(true);
    await registry.revokeRole(REVOKER_ROLE, stranger.address);
    expect(await registry.hasRole(REVOKER_ROLE, stranger.address)).to.equal(false);
  });

  // 3. Issuer authorization
  it("authorizes an issuer wallet bound to its institution", async () => {
    await expect(registry.authorizeIssuer(stranger.address, INST_B))
      .to.emit(registry, "IssuerAuthorized")
      .withArgs(stranger.address, INST_B);
    expect(await registry.getIssuerInstitution(stranger.address)).to.equal(INST_B);
    expect(await registry.hasRole(ISSUER_ROLE, stranger.address)).to.equal(true);
    await expect(registry.authorizeIssuer(ethers.ZeroAddress, INST_A))
      .to.be.revertedWith("NOSIH: zero issuer address");
    await expect(registry.authorizeIssuer(stranger.address, ethers.ZeroHash))
      .to.be.revertedWith("NOSIH: empty institution identity");
    await expect(registry.authorizeIssuer(stranger.address, INST_A))
      .to.be.revertedWith("NOSIH: issuer already authorized");
  });

  // 4. Issuer removal
  it("removes an issuer and blocks further issuance", async () => {
    await expect(registry.removeIssuer(issuerA.address))
      .to.emit(registry, "IssuerRemoved")
      .withArgs(issuerA.address, INST_A);
    expect(await registry.getIssuerInstitution(issuerA.address)).to.equal(ethers.ZeroHash);
    expect(await registry.hasRole(ISSUER_ROLE, issuerA.address)).to.equal(false);
    await expect(registry.connect(issuerA).issueCertificate(cert()))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await expect(registry.removeIssuer(issuerA.address))
      .to.be.revertedWith("NOSIH: issuer not authorized");
  });

  // 5. Valid certificate issuance
  it("issues a valid certificate recording msg.sender and block.timestamp", async () => {
    const c = cert({ issuer: stranger.address, issuedAt: 1, revoked: true, exists: true });
    const tx = await registry.connect(issuerA).issueCertificate(c);
    const receipt = await tx.wait();
    const block = await ethers.provider.getBlock(receipt.blockNumber);
    const stored = await registry.getCertificate(c.certificateIdHash);
    expect(stored.certificateIdHash).to.equal(c.certificateIdHash);
    expect(stored.institutionIdHash).to.equal(INST_A);
    expect(stored.holderIdentityHash).to.equal(c.holderIdentityHash);
    expect(stored.documentHash).to.equal(c.documentHash);
    expect(stored.metadataHash).to.equal(c.metadataHash);
    expect(stored.ipfsCID).to.equal(c.ipfsCID);
    expect(stored.issuer).to.equal(issuerA.address); // NOT the spoofed payload value
    expect(stored.issuedAt).to.equal(block.timestamp); // NOT the payload value
    expect(stored.revoked).to.equal(false);
    expect(stored.exists).to.equal(true);
    // invalid payloads are rejected
    await expect(registry.connect(issuerA).issueCertificate(cert({ certificateIdHash: id("CERT-EMPTY01"), documentHash: ethers.ZeroHash })))
      .to.be.revertedWith("NOSIH: empty documentHash");
    await expect(registry.connect(issuerA).issueCertificate(cert({ certificateIdHash: id("CERT-EMPTY02"), ipfsCID: "" })))
      .to.be.revertedWith("NOSIH: empty CID");
  });

  // 6. Unauthorized issuer rejection
  it("rejects issuance from unauthorized wallets", async () => {
    await expect(registry.connect(stranger).issueCertificate(cert()))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, ISSUER_ROLE);
  });

  // 7. Duplicate certificate rejection
  it("rejects duplicate certificate IDs", async () => {
    const c = cert();
    await registry.connect(issuerA).issueCertificate(c);
    await expect(registry.connect(issuerA).issueCertificate(c))
      .to.be.revertedWith("NOSIH: certificate exists");
    // same id from a different authorized issuer is also rejected
    await expect(
      registry.connect(issuerB).issueCertificate(cert({ institutionIdHash: INST_B }))
    ).to.be.revertedWith("NOSIH: certificate exists");
  });

  // 8. Institution mismatch rejection
  it("rejects issuance for an institution the wallet is not bound to", async () => {
    await expect(
      registry.connect(issuerA).issueCertificate(cert({ institutionIdHash: INST_B }))
    ).to.be.revertedWith("NOSIH: institution mismatch");
  });

  // 9. Certificate retrieval
  it("retrieves certificates and reports existence", async () => {
    const c = cert();
    expect(await registry.certificateExists(c.certificateIdHash)).to.equal(false);
    await expect(registry.getCertificate(c.certificateIdHash))
      .to.be.revertedWith("NOSIH: certificate not found");
    await registry.connect(issuerA).issueCertificate(c);
    expect(await registry.certificateExists(c.certificateIdHash)).to.equal(true);
    const stored = await registry.getCertificate(c.certificateIdHash);
    expect(stored.documentHash).to.equal(c.documentHash);
  });

  // 10. Certificate revocation
  it("revokes with a reason hash, permanently and auditable", async () => {
    const c = cert();
    await registry.connect(issuerA).issueCertificate(c);
    const reasonHash = id("revocation-reason|fraudulent marks");
    await expect(registry.connect(revoker).revokeCertificate(c.certificateIdHash, reasonHash))
      .to.emit(registry, "CertificateRevoked")
      .withArgs(c.certificateIdHash, revoker.address, reasonHash);
    const stored = await registry.getCertificate(c.certificateIdHash);
    expect(stored.revoked).to.equal(true);
    expect(await registry.revocationReasonHash(c.certificateIdHash)).to.equal(reasonHash);
    // issuer and stranger cannot revoke; reason hash is mandatory
    await expect(registry.connect(issuerA).revokeCertificate(c.certificateIdHash, reasonHash))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await expect(registry.connect(revoker).revokeCertificate(id("CERT-UNKNOWN1"), reasonHash))
      .to.be.revertedWith("NOSIH: certificate not found");
    const c2 = cert({ certificateIdHash: id("CERT-19C5D871"), documentHash: id("doc-2") });
    await registry.connect(issuerA).issueCertificate(c2);
    await expect(registry.connect(revoker).revokeCertificate(c2.certificateIdHash, ethers.ZeroHash))
      .to.be.revertedWith("NOSIH: reason hash required");
  });

  // 11. Double-revocation rejection
  it("rejects double revocation", async () => {
    const c = cert();
    await registry.connect(issuerA).issueCertificate(c);
    await registry.connect(revoker).revokeCertificate(c.certificateIdHash, id("reason"));
    await expect(registry.connect(revoker).revokeCertificate(c.certificateIdHash, id("reason-2")))
      .to.be.revertedWith("NOSIH: already revoked");
  });

  // 12. Certificate reissuance relationship
  it("links reissuance without overwriting the original", async () => {
    const original = cert();
    await registry.connect(issuerA).issueCertificate(original);
    const corrected = cert({
      certificateIdHash: id("CERT-73D1F920"),
      documentHash: id("doc-corrected"),
      metadataHash: id("meta-corrected"),
      supersedesCertificateIdHash: original.certificateIdHash,
    });
    await registry.connect(issuerA).issueCertificate(corrected);
    const oldStored = await registry.getCertificate(original.certificateIdHash);
    expect(oldStored.exists).to.equal(true);
    expect(oldStored.revoked).to.equal(false);
    expect(oldStored.documentHash).to.equal(original.documentHash); // untouched
    const newStored = await registry.getCertificate(corrected.certificateIdHash);
    expect(newStored.supersedesCertificateIdHash).to.equal(original.certificateIdHash);
    await expect(
      registry.connect(issuerA).issueCertificate(cert({
        certificateIdHash: id("CERT-BADLINK1"),
        documentHash: id("doc-x"),
        supersedesCertificateIdHash: id("CERT-NOTEXIST"),
      }))
    ).to.be.revertedWith("NOSIH: supersedes unknown certificate");
  });

  // 13. Expiration information
  it("stores expiration information and rejects past expiry", async () => {
    const latest = await ethers.provider.getBlock("latest");
    const future = latest.timestamp + 365 * 24 * 3600;
    const c = cert({ expiresAt: future });
    await registry.connect(issuerA).issueCertificate(c);
    const stored = await registry.getCertificate(c.certificateIdHash);
    expect(stored.expiresAt).to.equal(future);
    const noExpiry = cert({ certificateIdHash: id("CERT-NOEXPIRY"), documentHash: id("doc-ne"), expiresAt: 0 });
    await registry.connect(issuerA).issueCertificate(noExpiry);
    expect((await registry.getCertificate(noExpiry.certificateIdHash)).expiresAt).to.equal(0);
    await expect(
      registry.connect(issuerA).issueCertificate(cert({
        certificateIdHash: id("CERT-PASTEXP1"),
        documentHash: id("doc-pe"),
        expiresAt: latest.timestamp - 10,
      }))
    ).to.be.revertedWith("NOSIH: expiry in the past");
  });

  // 14. Event emission
  it("emits events for every important operation", async () => {
    await expect(registry.authorizeIssuer(stranger.address, INST_A))
      .to.emit(registry, "IssuerAuthorized").withArgs(stranger.address, INST_A);
    await expect(registry.removeIssuer(stranger.address))
      .to.emit(registry, "IssuerRemoved").withArgs(stranger.address, INST_A);
    const c = cert();
    await expect(registry.connect(issuerA).issueCertificate(c))
      .to.emit(registry, "CertificateIssued")
      .withArgs(
        c.certificateIdHash, INST_A, issuerA.address,
        c.documentHash, c.metadataHash, ethers.ZeroHash, c.ipfsCID,
        anyValue, 0
      );
    const reasonHash = id("reason");
    await expect(registry.connect(revoker).revokeCertificate(c.certificateIdHash, reasonHash))
      .to.emit(registry, "CertificateRevoked")
      .withArgs(c.certificateIdHash, revoker.address, reasonHash);
  });
});