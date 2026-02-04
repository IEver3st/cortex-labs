export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        panel: "rgba(18, 18, 20, 0.35)",
        surface: "rgba(22, 22, 24, 0.55)",
        accent: "#9be7c4",
        ink: "#e9ecef",
        slate: "#98a2b3",
      },
      boxShadow: {
        panel: "0 12px 30px rgba(0, 0, 0, 0.28)",
      },
    },
  },
};
