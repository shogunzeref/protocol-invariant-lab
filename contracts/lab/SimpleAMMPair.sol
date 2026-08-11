// SPDX-License-Identifier: MIT
pragma solidity 0.6.12;

import {IERC20} from '../dependencies/openzeppelin/contracts/IERC20.sol';

/**
 * Minimal constant-product AMM (x*y=k, 0.3% fee), written for this lab --
 * NOT Uniswap's actual bytecode. Captures the one property that matters
 * for this test: an unprivileged actor can move the pool's spot price by
 * trading against thin liquidity, with no admin/oracle-role call involved.
 */
contract SimpleAMMPair {
  IERC20 public immutable tokenA; // COLL
  IERC20 public immutable tokenB; // STABLE (numeraire, treated as $1)

  uint256 public reserveA;
  uint256 public reserveB;

  constructor(address _tokenA, address _tokenB) public {
    tokenA = IERC20(_tokenA);
    tokenB = IERC20(_tokenB);
  }

  function addLiquidity(uint256 amountA, uint256 amountB) external {
    require(tokenA.transferFrom(msg.sender, address(this), amountA), 'transferFrom A failed');
    require(tokenB.transferFrom(msg.sender, address(this), amountB), 'transferFrom B failed');
    reserveA += amountA;
    reserveB += amountB;
  }

  // Swap exact tokenA in for tokenB out (constant product, 0.3% fee)
  function swapAForB(uint256 amountAIn) external returns (uint256 amountBOut) {
    require(tokenA.transferFrom(msg.sender, address(this), amountAIn), 'transferFrom A failed');
    uint256 amountAInWithFee = (amountAIn * 997) / 1000;
    amountBOut = (reserveB * amountAInWithFee) / (reserveA + amountAInWithFee);
    reserveA += amountAIn;
    reserveB -= amountBOut;
    require(tokenB.transfer(msg.sender, amountBOut), 'transfer B failed');
  }

  function swapBForA(uint256 amountBIn) external returns (uint256 amountAOut) {
    require(tokenB.transferFrom(msg.sender, address(this), amountBIn), 'transferFrom B failed');
    uint256 amountBInWithFee = (amountBIn * 997) / 1000;
    amountAOut = (reserveA * amountBInWithFee) / (reserveB + amountBInWithFee);
    reserveB += amountBIn;
    reserveA -= amountAOut;
    require(tokenA.transfer(msg.sender, amountAOut), 'transfer A failed');
  }

  // Spot price of tokenA denominated in tokenB, scaled 1e18
  function spotPriceA() external view returns (uint256) {
    if (reserveA == 0) return 0;
    return (reserveB * 1e18) / reserveA;
  }
}
