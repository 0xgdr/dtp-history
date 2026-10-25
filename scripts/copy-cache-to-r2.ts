// One-off: copies a file cache (CACHE_DIR, e.g. Railway's /data/cache) into the R2 bucket that
// s3Cache reads. Both use `<namespace>/<key>.json`, so files are copied as they are. Entries
// already in the bucket are skipped, so it is safe to run again after an interruption.
//
//   bun scripts/copy-cache-to-r2.ts /data/cache
//
// Uses the same S3_BUCKET, S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY and CACHE_PREFIX
// as the server. The server can also run it at startup: see COPY_CACHE_FROM in ops/railway.md.
import { S3Client } from "bun";
import { copyDirToBucket } from "../src/cache.ts";
import { loadConfig } from "../src/config.ts";

const dir = process.argv[2];
const config = loadConfig();
if (!dir || !config.cacheBucket) {
  console.error("Usage: bun scripts/copy-cache-to-r2.ts <cache dir>, with S3_BUCKET and S3_* set.");
  process.exit(1);
}

console.log(`Copying ${dir} to ${config.cacheBucket}/${config.cachePrefix}`);
const stats = await copyDirToBucket(dir, new S3Client({ bucket: config.cacheBucket }), config.cachePrefix);
console.log(`Done: ${stats.copied} copied, ${stats.skipped} already there, ${stats.failed} failed.`);
if (stats.copied + stats.skipped + stats.failed === 0) {
  console.error(`No cache files in ${dir}: is that the right folder?`);
  process.exit(1);
}
if (stats.failed) process.exit(1);
