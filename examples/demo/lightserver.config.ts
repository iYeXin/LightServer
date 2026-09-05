// Local project config. Merge order:
// defaults < global (<dataDir>/lightserver.config.ts) < ./lightserver.config.ts < -c file < CLI flags.
export default {
  port: 5600,
  sites: {
    default: {
      root: "./public",
      routes: [
        { match: "/", root: "./public" },
        { match: "/api", root: "./api" },
      ],
      serviceOptions: { greeting: "Hello" },
    },
  },
};
