import fs from 'node:fs/promises';
import path from 'node:path';

async function main() {
  const distDir = path.resolve(process.cwd(), 'dist');
  const indexHtmlPath = path.join(distDir, 'index.html');
  const managementHtmlPath = path.join(distDir, 'management.html');

  try {
    await fs.access(indexHtmlPath);
  } catch {
    throw new Error(`Missing build output: ${indexHtmlPath}`);
  }

  await fs.copyFile(indexHtmlPath, managementHtmlPath);
  console.log(`Wrote: ${managementHtmlPath}`);
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
