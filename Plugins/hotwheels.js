let mergedCommands = ["hotwheels", "hw"];

const hotWheelsCollection = [
  {
    name: "Bone Shaker",
    model: "HW Dream Garage",
    series: "2024 Mainline",
    year: "2024",
    imgUrl: "https://static.wikia.nocookie.net/hotwheels/images/0/07/Bone_Shaker_2024.jpg/revision/latest?cb=20240101000000"
  },
  {
    name: "Twin Mill",
    model: "HW 55th Anniversary",
    series: "2023 Mainline",
    year: "2023",
    imgUrl: "https://m.media-amazon.com/images/I/71wZt4V4PmL._AC_SL1500_.jpg"
  },
  {
    name: "Rodger Dodger",
    model: "HW Digital Circuit",
    series: "2024 Mainline",
    year: "2024",
    imgUrl: "https://m.media-amazon.com/images/I/61N+HlXj5YL._AC_SL1200_.jpg"
  },
  {
    name: "Deora II",
    model: "HW Acceleracers Legend",
    series: "2023 Mainline",
    year: "2023",
    imgUrl: "https://m.media-amazon.com/images/I/71Yy3WJ8H1L._AC_SL1500_.jpg"
  },
  {
    name: "Batmobile (1989)",
    model: "HW Screen Time",
    series: "2024 Mainline",
    year: "2024",
    imgUrl: "https://m.media-amazon.com/images/I/61aG1e0tJbL._AC_SL1500_.jpg"
  },
  {
    name: "Nissan Skyline GT-R (R34)",
    model: "HW J-Imports",
    series: "2023 Mainline",
    year: "2023",
    imgUrl: "https://m.media-amazon.com/images/I/71k4sM2Z4LL._AC_SL1500_.jpg"
  },
  {
    name: "Dodge Charger SRT Hellcat",
    model: "HW Muscle Mania",
    series: "2024 Mainline",
    year: "2024",
    imgUrl: "https://m.media-amazon.com/images/I/71K+P7QJ4LL._AC_SL1500_.jpg"
  },
  {
    name: "Raijin Express",
    model: "HW Metro",
    series: "2023 Mainline",
    year: "2023",
    imgUrl: "https://m.media-amazon.com/images/I/71+G8l-hK0L._AC_SL1500_.jpg"
  },
  {
    name: "Mad Manga",
    model: "HW Drift",
    series: "2024 Mainline",
    year: "2024",
    imgUrl: "https://m.media-amazon.com/images/I/71v4uW8w9bL._AC_SL1500_.jpg"
  },
  {
    name: "Night Shifter",
    model: "HW Race Day",
    series: "2023 Mainline",
    year: "2023",
    imgUrl: "https://m.media-amazon.com/images/I/71Tj2eM3VPL._AC_SL1500_.jpg"
  }
];

export default {
  name: "hotwheels",
  alias: [...mergedCommands],
  uniquecommands: [...mergedCommands],
  description: "Get random Hot Wheels car",

  start: async (Hooper, m, { inputCMD, doReact }) => {
    switch (inputCMD) {
      case "hotwheels":
      case "hw":
        try {
          await doReact("🏎️");

          let carData;
          try {
            const res = await fetch("https://hot-wheels-rugs.onrender.com/api/random", { signal: AbortSignal.timeout(3000) });
            if (res.ok) {
              const data = await res.json();
              if (data && data.name && data.imgUrl) carData = data;
            }
          } catch {}

          if (!carData) {
            carData = hotWheelsCollection[Math.floor(Math.random() * hotWheelsCollection.length)];
          }

          await Hooper.sendMessage(
            m.from,
            {
              image: { url: carData.imgUrl },
              caption: `🏎️ *HOOPER-MD HOT WHEELS*\n\n🚘 *Name:* ${carData.name}\n🏎️ *Model:* ${carData.model}\n🏆 *Series:* ${carData.series}\n📅 *Year:* ${carData.year}`
            },
            { quoted: m }
          );

          await doReact("✅");
        } catch (e) {
          console.error("❌ Hot Wheels command error:", e.message);
          await Hooper.sendMessage(
            m.from,
            { text: "❌ Hooper-MD failed to fetch Hot Wheels car." },
            { quoted: m }
          );
        }
        break;

      default:
        break;
    }
  }
};