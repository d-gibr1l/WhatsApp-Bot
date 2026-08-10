export default [
  {
    files: ["src/**/*.js"],
    rules: {
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
