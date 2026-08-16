import {
  generateWalletManifest,
  verifyManifestKeyCorrespondence,
} from "./wallets/wallet-manifest.js";

const secretDirectory = process.argv[2];
if (secretDirectory === undefined || secretDirectory.trim().length === 0) {
  throw new Error(
    "usage: npm run wallets:create -- /absolute/repository-external/secret-directory",
  );
}

const manifest = await generateWalletManifest({ secretDirectory, count: 10, namespace: "entry" });
const verification = await verifyManifestKeyCorrespondence(manifest, secretDirectory);
if (verification.some((entry) => !entry.valid)) {
  throw new Error("wallet address-key correspondence failed");
}
process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: manifest.generatedAt,
      expectedChainId: 4663,
      wallets: verification,
      secretDirectory: "[repository-external]",
      privateKeysPrinted: false,
    },
    null,
    2,
  )}\n`,
);
