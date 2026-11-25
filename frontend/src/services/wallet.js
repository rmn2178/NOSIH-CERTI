/**
 * MetaMask wallet service — the ONLY place issuance is signed.
 *
 * The issuer's private key never leaves the browser: every signature happens
 * inside MetaMask. The backend prepares the exact call arguments and later
 * verifies the receipt independently; it can never issue on anyone's behalf.
 */

import { BrowserProvider } from "ethers";

/** Polygon Amoy testnet. */
export const AMOY_CHAIN_ID = Number(process.env.REACT_APP_CHAIN_ID || 80002);
const AMOY_CHAIN_HEX = "0x" + AMOY_CHAIN_ID.toString(16);

const AMOY_CHAIN_PARAMS = {
  chainId: AMOY_CHAIN_HEX,
  chainName: "Polygon Amoy Testnet",
  nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
  rpcUrls: [process.env.REACT_APP_AMOY_RPC_URL || "https://rpc-amoy.polygon.technology"],
  blockExplorerUrls: ["https://amoy.polygonscan.com"],
};

/** Thrown with a stable code so the UI can show precise guidance. */
export class WalletError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

export function hasMetaMask() {
  return Boolean(window.ethereum?.isMetaMask);
}

function getEthereum() {
  if (!window.ethereum) {
    throw new WalletError("NO_WALLET", "MetaMask was not detected. Install the MetaMask extension and reload this page.");
  }
  return window.ethereum;
}

/** Maps raw provider/RPC errors to a stable code + human message. */
export function classifyWalletError(err) {
  const code = err?.code ?? err?.info?.error?.code;
  if (code === 4001 || /user rejected|user denied/i.test(err?.message || "")) {
    return new WalletError("USER_REJECTED", "You rejected the request in MetaMask. Nothing was signed or sent.");
  }
  if (code === -32002) {
    return new WalletError("REQUEST_PENDING", "MetaMask already has a pending request. Open the extension and answer it.");
  }
  if (code === 4902) {
    return new WalletError("CHAIN_MISSING", "Polygon Amoy is not in your wallet yet. Add it and try again.");
  }
  if (err instanceof WalletError) return err;
  return new WalletError("WALLET_ERROR", err?.shortMessage || err?.message || "Wallet request failed");
}

/**
 * Connects and returns { provider, signer, account }.
 * Prompts MetaMask only when no account is connected yet.
 */
export async function connectWallet() {
  const ethereum = getEthereum();
  try {
    const accounts = await ethereum.request({ method: "eth_requestAccounts" });
    if (!accounts?.length) throw new WalletError("NO_ACCOUNT", "No account was shared by MetaMask.");
    const provider = new BrowserProvider(ethereum);
    const signer = await provider.getSigner();
    return { provider, signer, account: (await signer.getAddress()).toLowerCase() };
  } catch (err) {
    throw classifyWalletError(err);
  }
}

/** The chain the wallet is currently on (number). */
export async function getWalletChainId() {
  const ethereum = getEthereum();
  try {
    const hex = await ethereum.request({ method: "eth_chainId" });
    return Number(BigInt(hex));
  } catch (err) {
    throw classifyWalletError(err);
  }
}

/** Switches to Amoy, offering to add the network when the wallet lacks it. */
export async function ensureAmoyChain() {
  const ethereum = getEthereum();
  const current = await getWalletChainId();
  if (current === AMOY_CHAIN_ID) return AMOY_CHAIN_ID;

  try {
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: AMOY_CHAIN_HEX }],
    });
  } catch (err) {
    const code = err?.code ?? err?.info?.error?.code;
    if (code === 4902) {
      try {
        await ethereum.request({ method: "wallet_addEthereumChain", params: [AMOY_CHAIN_PARAMS] });
      } catch (addErr) {
        throw classifyWalletError(addErr);
      }
    } else {
      throw classifyWalletError(err);
    }
  }

  const after = await getWalletChainId();
  if (after !== AMOY_CHAIN_ID) {
    throw new WalletError("WRONG_CHAIN", `Wallet is on chain ${after}; issuance requires Polygon Amoy (${AMOY_CHAIN_ID}).`);
  }
  return after;
}

/**
 * Full pre-sign gate: connected account must equal the authorized issuer
 * wallet on file, and the wallet must be on Amoy.
 * @returns {{ provider, signer, account }}
 */
export async function connectAuthorizedIssuer(expectedWallet) {
  const { provider, signer, account } = await connectWallet();
  const expected = String(expectedWallet || "").toLowerCase();
  if (expected && account !== expected) {
    throw new WalletError(
      "ACCOUNT_MISMATCH",
      `MetaMask is connected to ${account}, but your authorized issuer wallet is ${expected}. Switch accounts in MetaMask.`
    );
  }
  await ensureAmoyChain();
  // The chain switch can change the active account in some wallets — re-read.
  const freshSigner = await provider.getSigner();
  const freshAccount = (await freshSigner.getAddress()).toLowerCase();
  if (expected && freshAccount !== expected) {
    throw new WalletError("ACCOUNT_MISMATCH", "The active MetaMask account changed during the network switch. Reconnect the authorized wallet.");
  }
  return { provider, signer: freshSigner, account: freshAccount };
}

/** Subscribes to account/chain changes; returns an unsubscribe function. */
export function onWalletChange(callback) {
  const ethereum = window.ethereum;
  if (!ethereum?.on) return () => {};
  const accountsHandler = (accounts) => callback({ type: "accounts", accounts: accounts.map((a) => a.toLowerCase()) });
  const chainHandler = (hex) => callback({ type: "chain", chainId: Number(BigInt(hex)) });
  ethereum.on("accountsChanged", accountsHandler);
  ethereum.on("chainChanged", chainHandler);
  return () => {
    ethereum.removeListener?.("accountsChanged", accountsHandler);
    ethereum.removeListener?.("chainChanged", chainHandler);
  };
}