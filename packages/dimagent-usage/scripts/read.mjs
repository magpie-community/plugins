import { findDim, readDim } from "../src/cli.mjs";
import { quotaFrom } from "../src/quota.mjs";

const path = await findDim(process.argv[2] ?? "");
const quota = quotaFrom(await readDim(path));
quota.user = "[redacted]";
console.log(JSON.stringify(quota, null, 2));
