import { verifyAssets } from './asset-integrity.mjs';

try {
  const { verified } = await verifyAssets();
  for (const asset of verified) console.log(`${asset.path}: ${asset.bytes} bytes, SHA-256 verified`);
} catch (error) {
  console.error(`Asset integrity failed: ${error.message}`);
  process.exitCode = 1;
}
