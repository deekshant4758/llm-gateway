// Usage: node scripts/create-key.js "My Key Name" 0.50
require("dotenv").config();
const { createKey } = require("../src/keys");

const [, , name, budget] = process.argv;
if (!name || !budget) {
  console.error('Usage: node scripts/create-key.js "<name>" <budget_usd>');
  process.exit(1);
}

const key = createKey({ name, budgetUsd: Number(budget) });
console.log("Created virtual key:");
console.log(JSON.stringify(key, null, 2));
console.log("\nSave the rawKey now — it is not recoverable (only its hash is stored).");
