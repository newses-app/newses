// Signed Windows build (`pnpm build:win:signed`, on Windows): electron-builder.yml plus Azure
// Artifact Signing. The values come from the environment: electron-builder.env (gitignored,
// written by scripts/windows-signing-setup.sh) locally, SSM in the release pipeline.
// electron-builder signs as AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET.
const required = [
  'AZURE_TENANT_ID',
  'AZURE_CLIENT_ID',
  'AZURE_CLIENT_SECRET',
  'WIN_SIGNING_ENDPOINT',
  'WIN_SIGNING_ACCOUNT_NAME',
  'WIN_SIGNING_PROFILE_NAME',
  'WIN_PUBLISHER_NAME',
];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) throw new Error(`Signed builds need ${missing.join(', ')}`);

module.exports = {
  extends: 'electron-builder.yml',
  win: {
    azureSignOptions: {
      endpoint: process.env.WIN_SIGNING_ENDPOINT,
      codeSigningAccountName: process.env.WIN_SIGNING_ACCOUNT_NAME,
      certificateProfileName: process.env.WIN_SIGNING_PROFILE_NAME,
      publisherName: process.env.WIN_PUBLISHER_NAME,
    },
  },
};
