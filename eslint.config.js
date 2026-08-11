import js from "@eslint/js";
import globals from "globals";

export default [
  {
    files: ["src/**/*.js", "index.js", "test/**/*.js", "tests/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "no-unused-vars": [
        "error",
        {
          "argsIgnorePattern": "^_",
          "varsIgnorePattern": "^_",
          "caughtErrorsIgnorePattern": "^_"
        }
      ],
      "no-empty": ["error", { "allowEmptyCatch": true }],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "Identifier[name=/^(readFileSync|writeFileSync|unlinkSync|mkdirSync|execSync|spawnSync)$/]",
          "message": "Synchronous fs and child_process methods block the event loop and are banned. Use async fsPromises or promisify(exec) instead."
        }
      ]
    }
  }
];
