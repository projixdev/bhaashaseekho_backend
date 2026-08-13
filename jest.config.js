/** @type {import('jest').Config} */
export default {
  testEnvironment: "node",
  transform: {},
  setupFiles: ["<rootDir>/tests/setupEnv.js"],
  testTimeout: 30000,
  testMatch: ["<rootDir>/tests/**/*.test.js"],
};
