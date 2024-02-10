import {
  PaginatedObjectsResponse,
  SuiClient,
  SuiObjectChangeCreated,
  SuiObjectData,
  SuiObjectResponse,
  getFullnodeUrl,
} from "@mysten/sui.js/client";
import { Ed25519Keypair } from "@mysten/sui.js/keypairs/ed25519";
import { TransactionBlock } from "@mysten/sui.js/transactions";
import { ZkSendLinkBuilder } from "@mysten/zksend";
import dotenv from "dotenv";
dotenv.config();

const GAS_BUDGET = Number(process.env.GAS_BUDGET ?? 0);
const GAS_TIPS = Number(process.env.GAS_TIPS ?? 0);
const SECRET_KEY = process.env.SECRET_KEY ?? "";
const OBJECT_TYPE = process.env.OBJECT_TYPE ?? "";
const LIMIT = Number(process.env.LIMIT ?? 0);

async function main() {
  // setup signer and sui client
  const signer = Ed25519Keypair.fromSecretKey(Buffer.from(SECRET_KEY, "hex"));
  const client = new SuiClient({ url: getFullnodeUrl("mainnet") });
  const signerAddr = signer.getPublicKey().toSuiAddress();
  console.log("signer:", signerAddr);

  // get target objects
  let hasNextPage = true;
  let cursor: string | null | undefined = null;
  let objectsVec = new Array<SuiObjectResponse[]>();
  let counter = 0;
  while (hasNextPage && counter < LIMIT) {
    const objectsRes: PaginatedObjectsResponse = await client.getOwnedObjects({
      owner: signerAddr,
      filter: {
        StructType: OBJECT_TYPE,
      },
      cursor,
      limit: LIMIT - counter > 50 ? 50 : LIMIT - counter,
    });
    objectsVec.push(objectsRes.data);
    hasNextPage = objectsRes.hasNextPage;
    cursor = objectsRes.nextCursor;
    counter += objectsRes.data.length;
  }
  const objectInfos = objectsVec.flat();
  const objectCount = objectInfos.length;
  console.log("object count:", objectCount);

  // generate gas coins for sending tx and gas tips for others
  const tx = new TransactionBlock();
  const amounts = new Array(objectCount).fill(
    tx.pure(GAS_BUDGET + GAS_TIPS, "u64")
  );
  console.log(amounts.length);
  const coins = tx.splitCoins(tx.gas, amounts);
  tx.transferObjects(
    amounts.map((_, idx) => coins[idx]),
    tx.pure(signerAddr, "address"),
  );
  const splitCoinsTxRes = await client.signAndExecuteTransactionBlock({
    transactionBlock: tx,
    signer,
    options: {
      showObjectChanges: true,
    },
  });
  // console.log(splitCoinsTxRes);
  if (!splitCoinsTxRes.objectChanges) return;
  const gasCoins: SuiObjectData[] = splitCoinsTxRes.objectChanges
    .filter((change) => change.type === "created")
    .map((change: any) => {
      const createdObject = change as SuiObjectChangeCreated;
      return {
        objectId: createdObject.objectId,
        version: createdObject.version,
        digest: createdObject.digest,
      };
    });
  console.log("sui coin count:", gasCoins.length);

  // generate links
  await Promise.all(
    objectInfos.map(async (obj, idx) => {
      const link = new ZkSendLinkBuilder({
        sender: signerAddr,
        client,
      });
      // console.log(obj.data);
      if (!obj.data) return;
      link.addClaimableObject(obj.data?.objectId);
      // this is so fucking annoying
      link.addClaimableMist(BigInt(GAS_TIPS));
      // why can't I add a SUI coin with addClaimableObject
      // link.addClaimableObject(gasCoin[2*idx+1].objectId);
      const tx = await link.createSendTransaction();
      tx.setGasPayment([gasCoins[idx]]);
      tx.setSender(signerAddr);
      tx.setGasOwner(signerAddr);
      const txRes = await client.signAndExecuteTransactionBlock({
        transactionBlock: tx,
        signer,
        options: {
          showEffects: true,
        },
      });
      if (txRes.effects?.status.status === "success") {
        const zklink = link.getLink();
        console.log(zklink);
        return zklink;
      };
    }),
  );
}

main().catch((err) => console.log(err));
