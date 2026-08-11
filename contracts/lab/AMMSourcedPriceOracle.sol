// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import {IPriceOracleGetter} from '../interfaces/IPriceOracleGetter.sol';
import {SimpleAMMPair} from './SimpleAMMPair.sol';

/**
 * Stands in for a production "AMM-derived oracle" (the class of design
 * behind both the historical Moola MOO/CELO incident and the March 2026
 * Venus THE incident -- reading spot price from a pool's own reserves
 * with no TWAP, no deviation cap, no staleness check). This is the
 * component being tested for manipulability: unlike PriceOracle.sol
 * (mocks/oracle), there is NO setAssetPrice() here. The only way the
 * price this contract reports can move is via real trades against the
 * underlying pair.
 */
contract AMMSourcedPriceOracle is IPriceOracleGetter {
  SimpleAMMPair public immutable pair;
  address public immutable collateralAsset;
  address public immutable numeraireAsset; // treated as fixed $1

  constructor(address _pair, address _collateralAsset, address _numeraireAsset) public {
    pair = SimpleAMMPair(_pair);
    collateralAsset = _collateralAsset;
    numeraireAsset = _numeraireAsset;
  }

  function getAssetPrice(address asset) external view override returns (uint256) {
    if (asset == numeraireAsset) return 1e18;
    if (asset == collateralAsset) return pair.spotPriceA();
    return 0;
  }
}
