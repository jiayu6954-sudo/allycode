import os from "node:os";
import path from "node:path";

process.env["ALLYCODE_DATA_DIR"] = path.join(
  os.tmpdir(),
  `allycode-tests-${process.pid}`,
);
