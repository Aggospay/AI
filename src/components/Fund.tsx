import { useState } from 'react'
import { ConnectKitButton } from 'connectkit'
import { erc20Abi } from 'viem'
import { useAccount, useReadContract, useSwitchChain, useWaitForTransactionReceipt, useWriteContract } from 'wagmi'
import { buildAddressExplorerUrl, buildTxExplorerUrl, getUsdc } from '@/onchain-facts'
import { Amount, parseAmount, usdcDecimalsFor } from '@/onchain-money'
import type { AgentState, StubFeature } from '@/lib/api'
import { short } from '@/lib/format'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/i18n'
import { Badge, Btn, Card, Empty, inputCls } from './ui'

/** Send testnet USDC from your own wallet to the agent wallet. The agent never receives your keys. */
export function Fund({ state }: { state: AgentState }) {
  const { t } = useI18n()
  const chainId = state.chain.id
  const usdcAddr = getUsdc(chainId)?.address as `0x${string}` | undefined
  const { address, chainId: walletChain, isConnected } = useAccount()
  const { switchChain, isPending: switching } = useSwitchChain()
  const [amount, setAmount] = useState('')
  const agent = state.addresses.agent as `0x${string}` | null
  const balance = useReadContract({ address: usdcAddr, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined, chainId, query: { enabled: !!address && !!usdcAddr } })
  const agentBal = useReadContract({ address: usdcAddr, abi: erc20Abi, functionName: 'balanceOf', args: agent ? [agent] : undefined, chainId, query: { enabled: !!agent && !!usdcAddr, refetchInterval: 5000 } })
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract()
  const receipt = useWaitForTransactionReceipt({ hash })
  const wrongChain = isConnected && walletChain !== chainId

  let parsed: bigint | null = null
  try {
    parsed = amount ? parseAmount(chainId, amount).raw : null
  } catch {
    parsed = null
  }
  const dec = usdcDecimalsFor(chainId)
  const fmt = (v?: bigint) => (v === undefined ? '-' : Amount.fromRaw(v, dec).toFixed(3))
  const tooMuch = parsed !== null && balance.data !== undefined && parsed > balance.data

  return (
    <Card title={t('fd.title')}>
      {!agent ? (
        <Empty>{t('fd.noWallet')}</Empty>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div><div className="label">{t('fd.agentWallet')}</div><a className="mono text-sm text-[var(--accent)] underline" href={buildAddressExplorerUrl(chainId, agent)} target="_blank" rel="noopener noreferrer">{short(agent)}</a></div>
            <div><div className="label">{t('fd.agentBalance')}</div><div className="display num text-xl font-semibold">{fmt(agentBal.data)} USDC</div></div>
          </div>
          {!isConnected ? (
            <div className="flex items-center gap-3"><ConnectKitButton label={t('fd.connect')} /></div>
          ) : wrongChain ? (
            <Btn variant="primary" busy={switching} onClick={() => switchChain({ chainId })}>{t('fd.switch', { chain: state.chain.name })}</Btn>
          ) : (
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); if (parsed && usdcAddr) writeContract({ address: usdcAddr, abi: erc20Abi, functionName: 'transfer', args: [agent, parsed], chainId }) }}>
              <label className="block flex-1 min-w-[180px]">
                <span className="text-sm text-[var(--ink-2)]">{t('fd.amount')}</span> <span className="num text-xs text-[var(--subtle)]">{t('fd.balance', { v: fmt(balance.data) })}</span>
                <input inputMode="decimal" value={amount} onChange={(e) => { setAmount(e.target.value); reset() }} placeholder="10.000" dir="ltr" className={`${inputCls} mt-1`} />
              </label>
              <Btn variant="primary" type="submit" busy={isPending || receipt.isLoading} disabled={!parsed || parsed <= 0n || tooMuch}>
                {isPending ? t('fd.confirmWallet') : receipt.isLoading ? t('fd.confirming') : t('fd.send')}
              </Btn>
            </form>
          )}
          {tooMuch && <p className="text-sm text-[var(--danger)]">{t('fd.tooMuch')}</p>}
          {error && <p className="text-sm text-[var(--danger)]">{error.message.split('\n')[0]}</p>}
          {receipt.isSuccess && hash && <p className="text-sm text-[var(--success)]">{t('fd.sent')} <a className="underline" href={buildTxExplorerUrl(chainId, hash)} target="_blank" rel="noopener noreferrer">{t('fd.view')}</a></p>}
          <p className="text-xs text-[var(--subtle)]">{t('fd.hint')}</p>
        </div>
      )}
    </Card>
  )
}

export function NotImplemented() {
  const { t, td } = useI18n()
  const stubs = useApi<StubFeature[]>('stubs', '/stubs', 60_000)
  return (
    <Card title={t('ni.title')}>
      <p className="mb-1 text-sm text-[var(--subtle)]">{t('ni.intro')}</p>
      <p className="mb-4 text-xs text-[var(--subtle)]">{t('lang.note')}</p>
      <ul className="divide-y divide-[var(--border)]">
        {(stubs.data ?? []).map((s) => (
          <li key={s.id} className="py-3">
            <div className="flex items-center gap-2"><span className="text-sm font-medium">{td(`stub.${s.id}`, s.name)}</span><Badge tone={s.status === 'partial' ? 'warn' : 'neutral'}>{s.status === 'partial' ? t('ni.partial') : t('ni.not')}</Badge></div>
            <p className="mt-1 text-sm text-[var(--ink-2)]">{s.what}</p>
            <p className="mt-0.5 text-xs text-[var(--subtle)]">{t('ni.needs', { v: s.needs })}</p>
          </li>
        ))}
      </ul>
    </Card>
  )
}
