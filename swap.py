
with open("src/downloader.js", "r", encoding="utf-8") as f:
    code = f.read()

# I will find API 2 block and API 3 block
api2_start = code.find("  try {\n    const res = await fetch(`https://social-media-video-downloader.p.rapidapi.com")
api2_end = code.find("  } catch (e) { console.log(\"[Downloader] API 2 failed:\", e.message); }\n") + len("  } catch (e) { console.log(\"[Downloader] API 2 failed:\", e.message); }\n")

api3_start = code.find("  try {\n    const res = await fetch(`https://youtube-info-download-api.p.rapidapi.com")
api3_end = code.find("  } catch (e) { console.log(\"[Downloader] API 3 failed:\", e.message); }\n") + len("  } catch (e) { console.log(\"[Downloader] API 3 failed:\", e.message); }\n")

api2_block = code[api2_start:api2_end]
api3_block = code[api3_start:api3_end]

code = code[:api2_start] + api3_block + "\n" + api2_block + code[api3_end:]

with open("src/downloader.js", "w", encoding="utf-8") as f:
    f.write(code)

