import { Address, BigDecimal, BigInt } from '@graphprotocol/graph-ts/index'

import { Bundle, Pair, Token } from '../../generated/schema'
import { ADDRESS_ZERO, ONE_BD, ZERO_BD, factoryContract } from './helpers'

// TODO: add proper pairs.
const WETH_ADDRESS = '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701'
const USDC_WETH_PAIR = '0x10ab4430394c9bdbdcac6b4b7b33a707ce2cee2b'
const USDT_WETH_PAIR = '0x0b411670f224951c5b57da742976adf189719e2a'

export function getEthPriceInUSD(): BigDecimal {
  // fetch eth prices for each stablecoin
  const usdcPair = Pair.load(USDC_WETH_PAIR) // usdc is token0
  const usdtPair = Pair.load(USDT_WETH_PAIR) // usdt is token1

  if (usdtPair !== null && usdcPair !== null) {
    const totalLiquidityETH = usdtPair.reserve1.plus(usdcPair.reserve1)
    const daiWeight = usdtPair.reserve1.div(totalLiquidityETH)
    const usdcWeight = usdcPair.reserve1.div(totalLiquidityETH)
    return usdtPair.token0Price.times(daiWeight).plus(usdcPair.token0Price.times(usdcWeight))
  }

  if (usdcPair !== null) {
    return usdcPair.token0Price
  }

  return ZERO_BD
}

// token where amounts should contribute to tracked volume and liquidity

const WHITELIST: string[] = [
  '0x760afe86e5de5fa0ee542fc7b7b713e1c5425701', // WMONAD
  '0x7d5d0ba109a6b9f6dde7d2a89a8150b589d49504', // USDC
  '0xca3feccd9139b990ebbf3873773333f8f25f85cd' // USDT
]

// minimum liquidity required to count towards tracked volume for pairs with small # of Lps
const MINIMUM_USD_THRESHOLD_NEW_PAIRS = BigDecimal.fromString('50000')

// minimum liquidity for price to get tracked
const MINIMUM_LIQUIDITY_THRESHOLD_ETH = BigDecimal.fromString('2')

/**
 * Search through graph to find derived Eth per token.
 * @todo update to be derived ETH (add stablecoin estimates)
 **/
export function findEthPerToken(token: Token): BigDecimal {
  if (token.id == WETH_ADDRESS) {
    return ONE_BD
  }

  // loop through whitelist and check if paired with any
  for (let i = 0; i < WHITELIST.length; ++i) {
    const pairAddress = factoryContract.getPair(Address.fromString(token.id), Address.fromString(WHITELIST[i]))
    if (pairAddress.toHexString() != ADDRESS_ZERO) {
      const pair = Pair.load(pairAddress.toHexString())
      if (pair === null) {
        continue
      }
      if (pair.token0 == token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        const token1 = Token.load(pair.token1)
        if (token1 === null) {
          continue
        }
        return pair.token1Price.times(token1.derivedETH as BigDecimal) // return token1 per our token * Eth per token 1
      }
      if (pair.token1 == token.id && pair.reserveETH.gt(MINIMUM_LIQUIDITY_THRESHOLD_ETH)) {
        const token0 = Token.load(pair.token0)
        if (token0 === null) {
          continue
        }
        return pair.token0Price.times(token0.derivedETH as BigDecimal) // return token0 per our token * ETH per token 0
      }
    }
  }
  return ZERO_BD // nothing was found return 0
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD.
 * If both are, return average of two amounts
 * If neither is, return 0
 */
export function getTrackedVolumeUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token,
  pair: Pair
): BigDecimal {
  const bundle = Bundle.load('1')!
  const price0 = token0.derivedETH.times(bundle.ethPrice)
  const price1 = token1.derivedETH.times(bundle.ethPrice)

  // if less than 5 LPs, require high minimum reserve amount amount or return 0
  if (pair.liquidityProviderCount.lt(BigInt.fromI32(5))) {
    const reserve0USD = pair.reserve0.times(price0)
    const reserve1USD = pair.reserve1.times(price1)
    if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve0USD.plus(reserve1USD).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
      if (reserve0USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
    if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
      if (reserve1USD.times(BigDecimal.fromString('2')).lt(MINIMUM_USD_THRESHOLD_NEW_PAIRS)) {
        return ZERO_BD
      }
    }
  }

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1)).div(BigDecimal.fromString('2'))
  }

  // take full value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0)
  }

  // take full value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1)
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}

/**
 * Accepts tokens and amounts, return tracked amount based on token whitelist
 * If one token on whitelist, return amount in that token converted to USD * 2.
 * If both are, return sum of two amounts
 * If neither is, return 0
 */
export function getTrackedLiquidityUSD(
  tokenAmount0: BigDecimal,
  token0: Token,
  tokenAmount1: BigDecimal,
  token1: Token
): BigDecimal {
  const bundle = Bundle.load('1')!
  const price0 = token0.derivedETH.times(bundle.ethPrice)
  const price1 = token1.derivedETH.times(bundle.ethPrice)

  // both are whitelist tokens, take average of both amounts
  if (WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).plus(tokenAmount1.times(price1))
  }

  // take double value of the whitelisted token amount
  if (WHITELIST.includes(token0.id) && !WHITELIST.includes(token1.id)) {
    return tokenAmount0.times(price0).times(BigDecimal.fromString('2'))
  }

  // take double value of the whitelisted token amount
  if (!WHITELIST.includes(token0.id) && WHITELIST.includes(token1.id)) {
    return tokenAmount1.times(price1).times(BigDecimal.fromString('2'))
  }

  // neither token is on white list, tracked volume is 0
  return ZERO_BD
}
