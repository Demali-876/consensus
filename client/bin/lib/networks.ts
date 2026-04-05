export type NetworkOption = {
  label: string;
  caip2: string;
  chain: string;
  asset: string;
};

export const NETWORK_OPTIONS: NetworkOption[] = [
  // auto — let the server (and signer availability) decide
  { label: 'auto',            caip2: '',                                              chain: 'any',          asset: 'any'     },

  // EVM
  { label: 'BaseSep · USDC',  caip2: 'eip155:84532',                                 chain: 'Base Sepolia', asset: 'USDC'    },
  { label: 'Base · USDC',     caip2: 'eip155:8453',                                  chain: 'Base',         asset: 'USDC'    },
  { label: 'EthSep · ETH',    caip2: 'eip155:11155111',                              chain: 'Eth Sepolia',  asset: 'ETH'     },
  { label: 'Eth · ETH',       caip2: 'eip155:1',                                     chain: 'Ethereum',     asset: 'ETH'     },

  // Solana
  { label: 'SolDev · USDC',   caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',     chain: 'Sol Devnet',   asset: 'USDC'    },
  { label: 'SolMain · USDC',  caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',     chain: 'Sol Mainnet',  asset: 'USDC'    },

  // ICP
  { label: 'ICP · TESTICP',   caip2: 'icp:1:xafvr-biaaa-aaaai-aql5q-cai',           chain: 'ICP',          asset: 'TESTICP' },
  { label: 'ICP · ckUSDC',    caip2: 'icp:1:cngnf-vqaaa-aaaar-qag4q-cai',           chain: 'ICP',          asset: 'ckUSDC'  },
  { label: 'ICP · ckETH',     caip2: 'icp:1:xevnm-gaaaa-aaaar-qafnq-cai',           chain: 'ICP',          asset: 'ckETH'   },
];

/** CAIP-2 values in the same order as NETWORK_OPTIONS ('' = auto). */
export const NETWORK_CAIP2S  = NETWORK_OPTIONS.map(n => n.caip2);

/** Short display labels in the same order as NETWORK_OPTIONS. */
export const NETWORK_LABELS  = NETWORK_OPTIONS.map(n => n.label);
