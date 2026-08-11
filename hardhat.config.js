require("@nomicfoundation/hardhat-toolbox");

module.exports = {
  solidity: {
    version: "0.6.12",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "istanbul",
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      blockGasLimit: 30000000,
    },
  },
  mocha: { timeout: 200000 },
};
