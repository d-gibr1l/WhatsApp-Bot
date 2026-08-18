
import os, re

with open("index.js", "r", encoding="utf-8") as f:
    idx = f.read()

idx = re.sub(r"if \(fs\.existsSync\(\"./wireproxy\.conf\"\)\) \{[^{}]*\}\n", "", idx)

with open("index.js", "w", encoding="utf-8") as f:
    f.write(idx)

with open("build.sh", "r", encoding="utf-8") as f:
    bsh = f.read()

bsh = re.sub(r"echo \"Downloading wireproxy.*?rm wireproxy\.tar\.gz\n", "", bsh, flags=re.DOTALL)

with open("build.sh", "w", encoding="utf-8") as f:
    f.write(bsh)

with open("Dockerfile", "r", encoding="utf-8") as f:
    dkf = f.read()

dkf = re.sub(r"    curl -L https://github\.com/windtf/wireproxy/.*?rm wireproxy\.tar\.gz && \\\n", "", dkf, flags=re.DOTALL)

with open("Dockerfile", "w", encoding="utf-8") as f:
    f.write(dkf)

with open("src/downloader.js", "r", encoding="utf-8") as f:
    dl = f.read()

dl = re.sub(r"\s*if \(process\.env\.WIREPROXY_ENABLED === \"true\"\) args\.push\(\"--proxy\", \"socks5://127\.0\.0\.1:1080\"\);\n", "", dl)

with open("src/downloader.js", "w", encoding="utf-8") as f:
    f.write(dl)

