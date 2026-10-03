export default {
  test: {
    include: ["packages/browser/retained-tests/*.test.mjs"],
    environment: "node",
    maxWorkers: 2,
  },
};
