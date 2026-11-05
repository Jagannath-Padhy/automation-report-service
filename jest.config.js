// Jest is used only for the TRV14 report validations (npm run test:trv14);
// the existing `npm test` (mocha) is unchanged.
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: ["<rootDir>/src/validations/ONDC:TRV14/__tests__/**/*.test.ts"],
  testTimeout: 120000,
};
