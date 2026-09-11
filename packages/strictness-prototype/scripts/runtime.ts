console.log(JSON.stringify({
  bun: Bun.version,
  revision: Bun.revision,
  platform: process.platform,
  architecture: process.arch,
}));
