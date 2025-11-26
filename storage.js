const fs = require("fs");
const path = require("path");

const DEFAULT_DATA_DIR = path.join(__dirname, "data");

function resolveBaseDir() {
  const customDir =
    process.env.DATA_DIR ||
    process.env.RAILWAY_VOLUME_MOUNT_PATH ||
    process.env.RAILWAY_PERSISTENT_VOLUME_PATH;
  if (customDir) {
    return path.resolve(customDir);
  }
  return DEFAULT_DATA_DIR;
}

const DATA_DIR = resolveBaseDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

function resolveDataPath(...segments) {
  return path.join(DATA_DIR, ...segments);
}

module.exports = {
  DATA_DIR,
  resolveDataPath,
};
