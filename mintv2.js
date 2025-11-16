require('dotenv').config();
const axios = require('axios');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');

const {
  PRIVATE_KEY,
  CAPTCHA_KEY,
  TURNSTILE_SITEKEY,
  RPC,
  API_BASE,
  CLIENT_ID,
  RECIPIENT,
  RELAYER,
  TOKEN,
  MINT_COUNT = 100
} = process.env;

const provider = new ethers.providers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const WALLET = wallet.address;

const delay = (ms) => new Promise(r => setTimeout(r, ms));

/* -------------------------------------------------------------
   CAPTCHA SOLVER
-------------------------------------------------------------*/
async function solveTurnstile() {
  const job = await axios.get(
    `http://2captcha.com/in.php?key=${CAPTCHA_KEY}&method=turnstile&sitekey=${TURNSTILE_SITEKEY}&pageurl=https://www.b402.ai/experience-b402&json=1`
  );
  const id = job.data.request;

  while (true) {
    await delay(5000);
    const r = await axios.get(
      `http://2captcha.com/res.php?key=${CAPTCHA_KEY}&action=get&id=${id}&json=1`
    );
    if (r.data.status === 1) return r.data.request;
    process.stdout.write(".");
  }
}

/* -------------------------------------------------------------
   AUTH
-------------------------------------------------------------*/
async function getChallenge(ts) {
  const lid = randomUUID();
  const res = await axios.post(`${API_BASE}/auth/web3/challenge`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    turnstileToken: ts
  });
  return { lid, challenge: res.data };
}

async function verifyChallenge(lid, sig, ts) {
  const res = await axios.post(`${API_BASE}/auth/web3/verify`, {
    walletType: "evm",
    walletAddress: WALLET,
    clientId: CLIENT_ID,
    lid,
    signature: sig,
    turnstileToken: ts
  });
  return res.data;
}

/* -------------------------------------------------------------
   APPROVE USDT UNLIMITED
-------------------------------------------------------------*/
async function approveUnlimited() {
  const abi = ["function approve(address spender, uint256 value)"];
  const token = new ethers.Contract(TOKEN, abi, wallet);

  const Max = ethers.constants.MaxUint256;
  console.log("🟦 Approving unlimited USDT for relayer...");

  const tx = await token.approve(RELAYER, Max);
  console.log("🔄 Approve TX:", tx.hash);
  await tx.wait();

  console.log("🟩 Unlimited USDT approved!");
}

/* -------------------------------------------------------------
   PERMIT BUILDER (VALID)
-------------------------------------------------------------*/
async function buildPermit(amount, relayer) {
  const net = await provider.getNetwork();
  const now = Math.floor(Date.now() / 1000);

  const msg = {
    token: TOKEN,
    from: WALLET,
    to: RECIPIENT,
    value: amount,
    validAfter: now - 20,
    validBefore: now + 1800,
    nonce: ethers.utils.hexlify(ethers.utils.randomBytes(32))
  };

  const domain = {
    name: "B402",
    version: "1",
    chainId: net.chainId,
    verifyingContract: relayer
  };

  const types = {
    TransferWithAuthorization: [
      { name: "token", type: "address" },
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" }
    ]
  };

  const sig = await wallet._signTypedData(domain, types, msg);
  return { authorization: msg, signature: sig };
}

/* -------------------------------------------------------------
   MAIN
-------------------------------------------------------------*/
(async () => {
  console.log("🚀 TURBO v41 — AUTO APPROVE + PREPAY + PERMIT BLAST");

  /* LOGIN ---------------------------------------------------*/
  const ts = await solveTurnstile();
  const { lid, challenge } = await getChallenge(ts);
  const signed = await wallet.signMessage(challenge.message);
  const verify = await verifyChallenge(lid, signed, ts);
  const jwt = verify.jwt || verify.token;
  console.log("🟩 Logged in!");

  /* APPROVE --------------------------------------------------*/
  await approveUnlimited();

  /* TRIGGER REAL 402 -----------------------------------------*/
  console.log("🔍 Fetching REAL payment requirement...");
  let pay;
  try {
    await axios.post(`${API_BASE}/faucet/drip`,
      { recipientAddress: RECIPIENT },
      { headers: { Authorization: `Bearer ${jwt}` } }
    );
  } catch (err) {
    if (err.response?.status === 402) {
      pay = err.response.data.paymentRequirements;
      console.log("💰 Payment requirement FOUND:", pay.amount);
    } else {
      throw new Error("❌ Cannot obtain payment requirement");
    }
  }

  /* BUILD PERMITS -------------------------------------------*/
  console.log(`🧱 Building ${MINT_COUNT} turbo permits...`);
  const permits = [];
  for (let i = 0; i < MINT_COUNT; i++) {
    permits.push(await buildPermit(pay.amount, pay.relayerContract));
    console.log(`✔ Permit ${i + 1}`);
  }

  /* FIRE ALL PERMITS (TURBO PARALLEL) ------------------------*/
  console.log("\n🚀 BLASTING PERMITS (ultra-parallel)...");

  await Promise.all(
    permits.map(async (p, i) => {
      try {
        const r = await axios.post(
          `${API_BASE}/faucet/drip`,
          {
            recipientAddress: RECIPIENT,
            paymentPayload: { token: TOKEN, payload: p },
            paymentRequirements: {
              network: pay.network,
              relayerContract: pay.relayerContract
            }
          },
          { headers: { Authorization: `Bearer ${jwt}` } }
        );

        console.log(`🟩 Mint #${i + 1} SUCCESS → ${r.data.nftTransaction}`);
      } catch (e) {
        console.log(`🟥 Mint #${i + 1} FAILED →`, e.response?.data || e.message);
      }
    })
  );

  console.log("\n🎉 DONE — TURBO COMPLETE!");
})();
