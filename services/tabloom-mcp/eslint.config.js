import { globalIgnores } from "eslint/config";
import rootConfig from "../../eslint.config.mjs";

export default [
  ...rootConfig,
  globalIgnores([".next/**"]),
];
