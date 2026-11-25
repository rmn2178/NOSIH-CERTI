/**
 * P6 integration gate — the REAL backend blockchain service against a REAL
 * (in-memory Hardhat) chain. No live network writes, no mocks of the service:
 * every assertion exercises backend/services/blockchain.js exactly as the
 * confirm route will call it in production.
 *
 * Covers: receipt verification (happy path + every rejection branch),
 * pending/reverted transactions, chain reads, revocation roundtrip, and the
 * config/unavailable error taxonomy.
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

const id = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const INST_HASH = id("INST-AAAAAAAA");
const CERT_HASH = id("CERT-8A91F203");
const OTHER_CERT_HASH = id("CERT-0000FFFF");

function intentValues(overrides = {}) {
  return {
    certificateIdHash: CERT_HASH,
    institutionIdHash: INST_HASH,
    holderIdentityHash: id("holder-1"),
    documentHash: id("doc-1"),
    metadataHash: id("meta-1"),
    ipfsCID: "bafyTestCid",
    issuer: ethers.ZeroAddress, // contract stamps msg.sender
    issuedAt: 0, // contract stamps block.timestamp
    expiresAt: 0,
    revoked: false,
    exists: false,
    supersedesCertificateIdHash: ethers.ZeroHash,
    ...overrides,
  };
}

function expectedFrom(values, issuerWallet, overrides = {}) {
  return {
    certificateIdHash: values.certificateIdHash,
    documentHash: values.documentHash,
    metadataHash: values.metadataHash,
    institutionIdHash: values.institutionIdHash,
    issuerWallet,
    ipfsCID: values.ipfsCID,
    chainExpiresAt: values.expiresAt,
    supersedesCertificateIdHash: values.supersedesCertificateIdHash,
    ...overrides,
  };
}

describe("Issuance handshake — backend blockchain service (P6)", function () {
  let chain; // the real ESM service under test
  let registry, registryAddress, admin, issuer, revoker, stranger;
  let provider, chainId;

  before(async () => {
    // ESM service loaded into the CommonJS Hardhat test runtime.
    chain = await import("../backend/services/blockchain.js");
    provider = ethers.provider;
    chainId = Number((await provider.getNetwork()).chainId); // 31337
  });

  beforeEach(async () => {
    [admin, issuer, revoker, stranger] = await ethers.getSigners();
    registry = await (await ethers.getContractFactory("CertificateRegistry")).deploy();
    registryAddress = await registry.getAddress();
    await registry.authorizeIssuer(issuer.address, INST_HASH);
    await registry.grantRole(await registry.REVOKER_ROLE(), revoker.address);
  });

  const issue = async (values) => {
    const tx = await registry.connect(issuer).issueCertificate(values);
    const receipt = await tx.wait();
    return { txHash: receipt.hash, receipt };
  };

  const verify = (txHash, expected, overrides = {}) =>
    chain.verifyIssuanceReceipt({
      txHash,
      expected,
      provider,
      contractAddress: registryAddress,
      chainId,
      ...overrides,
    });

  // 1. Happy path — the exact confirm-stage call
  it("confirms a genuine issuance receipt and returns the block timestamp", async () => {
    const values = intentValues();
    const { txHash, receipt } = await issue(values);
    const block = await provider.getBlock(receipt.blockNumber);

    const result = await verify(txHash, expectedFrom(values, issuer.address));
    expect(result.ok).to.equal(true);
    expect(result.state).to.equal("confirmed");
    expect(result.blockNumber).to.equal(receipt.blockNumber);
    expect(result.issuedAt).to.equal(Number(block.timestamp));
  });

  // 2. Every pinned field is independently enforced
  it("rejects a receipt whose on-chain fields differ from the intent", async () => {
    const values = intentValues();
    const { txHash } = await issue(values);
    const base = expectedFrom(values, issuer.address);

    const tampered = [
      [{ documentHash: id("doc-EVIL") }, "documentHash"],
      [{ metadataHash: id("meta-EVIL") }, "metadataHash"],
      [{ institutionIdHash: id("INST-EVIL") }, "institutionIdHash"],
      [{ issuerWallet: stranger.address }, "issuer"],
      [{ ipfsCID: "bafyEvilCid" }, "ipfsCID"],
      [{ chainExpiresAt: 12345 }, "expiresAt"],
      [{ supersedesCertificateIdHash: OTHER_CERT_HASH }, "supersedesCertificateIdHash"],
    ];
    for (const [override, field] of tampered) {
      const result = await verify(txHash, { ...base, ...override });
      expect(result.ok, field).to.equal(false);
      expect(result.state, field).to.equal("rejected");
      expect(result.reason, field).to.contain(field);
    }
  });

  // 3. Wrong contract
  it("rejects a transaction sent to a different contract", async () => {
    const values = intentValues();
    const { txHash } = await issue(values);
    const other = await (await ethers.getContractFactory("CertificateRegistry")).deploy();
    const result = await verify(txHash, expectedFrom(values, issuer.address), {
      contractAddress: await other.getAddress(),
    });
    expect(result.state).to.equal("rejected");
    expect(result.reason).to.contain("CertificateRegistry");
  });

  // 4. Wrong chain
  it("rejects a receipt from the wrong chain", async () => {
    const values = intentValues();
    const { txHash } = await issue(values);
    const result = await verify(txHash, expectedFrom(values, issuer.address), { chainId: 80002 });
    expect(result.state).to.equal("rejected");
    expect(result.reason).to.contain("chain");
  });

  // 5. Unknown transaction → pending (202 path)
  it("reports an unknown transaction as pending, never confirmed", async () => {
    const unknown = "0x" + "ab".repeat(32);
    const result = await verify(unknown, expectedFrom(intentValues(), issuer.address));
    expect(result.ok).to.equal(false);
    expect(result.state).to.equal("pending");
  });

  // 6. Malformed hash
  it("rejects a malformed transaction hash without touching the chain", async () => {
    const result = await verify("0x1234", expectedFrom(intentValues(), issuer.address));
    expect(result.state).to.equal("rejected");
    expect(result.reason).to.contain("Malformed");
  });

  // 7. Reverted transaction (automine off so the revert is MINED, not thrown)
  it("rejects a reverted transaction", async () => {
    const values = intentValues();
    await issue(values); // first issuance succeeds
    const data = registry.interface.encodeFunctionData("issueCertificate", [values]);

    await network.provider.send("evm_setAutomine", [false]);
    let txHash;
    try {
      const tx = await issuer.sendTransaction({ to: registryAddress, data, gasLimit: 600000 });
      txHash = tx.hash;
      await network.provider.send("evm_mine", []);
    } finally {
      await network.provider.send("evm_setAutomine", [true]);
    }
    const receipt = await provider.getTransactionReceipt(txHash);
    expect(receipt.status).to.equal(0); // mined, but reverted (duplicate id)

    const result = await verify(txHash, expectedFrom(values, issuer.address));
    expect(result.state).to.equal("rejected");
    expect(result.reason).to.contain("reverted");
  });

  // 8. Event must be for THIS certificate
  it("rejects a receipt whose CertificateIssued event is for another certificate", async () => {
    const values = intentValues({ certificateIdHash: OTHER_CERT_HASH });
    const { txHash } = await issue(values);
    // Intent pins CERT_HASH, but the transaction issued OTHER_CERT_HASH.
    const result = await verify(txHash, expectedFrom(intentValues(), issuer.address));
    expect(result.state).to.equal("rejected");
    expect(result.reason).to.contain("No CertificateIssued event");
  });

  // 9. Expiry + supersedes happy paths
  it("confirms issuance with expiry and a supersedes link", async () => {
    const original = intentValues();
    await issue(original);
    const future = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const reissue = intentValues({
      certificateIdHash: OTHER_CERT_HASH,
      expiresAt: future,
      supersedesCertificateIdHash: CERT_HASH,
    });
    const { txHash } = await issue(reissue);
    const result = await verify(txHash, expectedFrom(reissue, issuer.address));
    expect(result.state).to.equal("confirmed");
  });

  // 10. Chain reads
  it("reads certificates and issuer bindings, and returns null for unknown ids", async () => {
    const values = intentValues();
    await issue(values);

    const onChain = await chain.readCertificate(CERT_HASH, { provider, contractAddress: registryAddress });
    expect(onChain).to.not.equal(null);
    expect(onChain.documentHash).to.equal(values.documentHash);
    expect(onChain.metadataHash).to.equal(values.metadataHash);
    expect(onChain.ipfsCID).to.equal(values.ipfsCID);
    expect(onChain.issuer.toLowerCase()).to.equal(issuer.address.toLowerCase());
    expect(onChain.revoked).to.equal(false);
    expect(onChain.exists).to.equal(true);

    const missing = await chain.readCertificate(OTHER_CERT_HASH, { provider, contractAddress: registryAddress });
    expect(missing).to.equal(null);

    let badRequest = null;
    try {
      await chain.readCertificate("not-a-hash", { provider, contractAddress: registryAddress });
    } catch (err) {
      badRequest = err;
    }
    expect(badRequest?.status).to.equal(400);

    const binding = await chain.getIssuerInstitutionFromChain(issuer.address, { provider, contractAddress: registryAddress });
    expect(binding).to.equal(INST_HASH);
  });

  // 11. Revocation roundtrip (the ONLY server-side signing path)
  it("revokes on-chain with an injected signer and the read reflects it", async () => {
    const values = intentValues();
    await issue(values);
    const reasonHash = id("revocation-reason|fraud");

    const { txHash, blockNumber } = await chain.revokeCertificateOnChain(CERT_HASH, reasonHash, {
      signer: revoker,
      contractAddress: registryAddress,
    });
    expect(txHash).to.match(/^0x[0-9a-f]{64}$/);
    expect(blockNumber).to.be.a("number");

    const onChain = await chain.readCertificate(CERT_HASH, { provider, contractAddress: registryAddress });
    expect(onChain.revoked).to.equal(true);
    expect(await registry.revocationReasonHash(CERT_HASH)).to.equal(reasonHash);

    // A revoked certificate can never be confirmed as a fresh issuance again:
    // the receipt still verifies (issuance happened), but reads show revoked.
    await expect(
      registry.connect(revoker).revokeCertificate(CERT_HASH, reasonHash)
    ).to.be.revertedWith("NOSIH: already revoked");
  });

  // 12. Error taxonomy — missing config is a clear 503, never a fake success
  it("raises ChainConfigError when CONTRACT_ADDRESS / REVOKE_PRIVATE_KEY are missing", async () => {
    const savedAddress = process.env.CONTRACT_ADDRESS;
    const savedKey = process.env.REVOKE_PRIVATE_KEY;
    delete process.env.CONTRACT_ADDRESS;
    delete process.env.REVOKE_PRIVATE_KEY;
    try {
      expect(() => chain.getContractAddress()).to.throw(chain.ChainConfigError);
      expect(() => chain.getRevocationSigner()).to.throw(chain.ChainConfigError);
      let status = null;
      try {
        chain.getContractAddress();
      } catch (err) {
        status = err.status;
      }
      expect(status).to.equal(503);
    } finally {
      if (savedAddress !== undefined) process.env.CONTRACT_ADDRESS = savedAddress;
      if (savedKey !== undefined) process.env.REVOKE_PRIVATE_KEY = savedKey;
    }
  });

  // 13. Error taxonomy — an unreachable chain is INDETERMINATE, not "valid"
  it("raises ChainUnavailableError when the chain cannot be reached", async () => {
    // Port 9 (discard) refuses connections immediately — no live network use.
    const deadProvider = new ethers.JsonRpcProvider("http://127.0.0.1:9", chainId, { staticNetwork: true });
    const values = intentValues();

    let verifyErr = null;
    try {
      await chain.verifyIssuanceReceipt({
        txHash: "0x" + "cd".repeat(32),
        expected: expectedFrom(values, issuer.address),
        provider: deadProvider,
        contractAddress: registryAddress,
        chainId,
      });
    } catch (err) {
      verifyErr = err;
    }
    expect(verifyErr).to.be.instanceOf(chain.ChainUnavailableError);
    expect(verifyErr.status).to.equal(503);

    let readErr = null;
    try {
      await chain.readCertificate(CERT_HASH, { provider: deadProvider, contractAddress: registryAddress });
    } catch (err) {
      readErr = err;
    }
    expect(readErr).to.be.instanceOf(chain.ChainUnavailableError);
  });

  // 14. The service must contain NO issuance signing capability
  it("exposes no issuance signer — issueCertificate is browser-only", () => {
    expect(chain.registerRecordOnChain).to.equal(undefined);
    expect(chain.getSigner).to.equal(undefined);
    expect(chain.issueCertificateOnChain).to.equal(undefined);
    // Revocation is the only write, and it demands the dedicated key.
    expect(chain.revokeCertificateOnChain).to.be.a("function");
    expect(chain.getRevocationSigner).to.be.a("function");
  });
});