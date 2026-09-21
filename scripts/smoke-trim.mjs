// 历史流水裁剪留存 —— 逻辑冒烟测试（esbuild 打包后在 node 运行）
// 覆盖：流水超上限裁剪后归档留存、历史对账无虚假差异、已发任务奖励不被重复补发、
//       余额链锚点衔接、真实差异仍可检出补偿、看板统计与领奖台账一致
import { setActivePinia, createPinia } from 'pinia'
import { usePlatformStore } from '@/store/platform'

setActivePinia(createPinia())
const s = usePlatformStore()
s.init()

let failed = 0
const assert = (cond, msg) => {
  if (cond) console.log('  ✅', msg)
  else { console.error('  ❌', msg); failed++ }
}

const today = s.todayDate
const d1 = s.reconDates[1] // 上一业务日（种子预置 5 积分任务漏记）
const d2 = s.reconDates[2] // 前两业务日（seed-tc1 任务奖励 +15 已结算）

console.log('— 基线：历史业务日账态 —')
s.runRecon(d2, true)
assert(s.reconBillOf(d2).diffs.openCount === 0, '前日初始账实相符（seed-tc1 +15 已发奖）')
s.runRecon(d1, true)
assert(s.reconBillOf(d1).diffs.points.residual === 5, '昨日存在真实漏记 +5（种子预置，非裁剪差异）')
const issued0 = s.dashboard.pointsIssued
const comp0 = s.dashboard.reconCompensated
const claims0 = s.taskClaims.length

console.log('— 手动任务奖励入账（随后将被裁剪归档）—')
s.completeTask('t-checkin') // +5「完成任务：每日签到」
s.completeTask('t-watch')   // +10「完成任务：观看今日视频」
assert(s.pointRecords.some((p) => p.note === '完成任务：每日签到'), '签到奖励流水在账')

console.log('— 触发流水裁剪（超 300 条留存上限）—')
const flowsBefore = s.pointRecords.length
for (let i = 0; i < 320; i++) {
  // 一正一负净额为 0 的压测流水（先改余额再记账，保持余额链连续）
  if (i % 2 === 0) { s.points += 1; s.addPointRecord(1, '压测入账', 'normal') }
  else { s.points -= 1; s.addPointRecord(-1, '压测出账', 'normal') }
}
assert(s.pointRecords.length <= 300, `流水裁剪至留存上限（现存 ${s.pointRecords.length} 条）`)
const archivedCount = s.flowArchive.reduce((n, a) => n + a.count, 0)
assert(archivedCount > 0 && s.pointRecords.length + archivedCount === flowsBefore + 320,
  `裁剪流水全部归档留存、无丢失（归档 ${archivedCount} 笔）`)
assert(!s.pointRecords.some((p) => p.id === 'seed-pr1'), '前日任务结算流水已被裁出现存')
const archD2 = s.flowArchive.find((a) => a.bizDate === d2)
assert(archD2 && archD2.net === 15 && archD2.taskRewards.some((t) => t.claimId === 'seed-tc1'),
  '归档台账按业务日留存前日任务结算明细（净额 +15、台账 id seed-tc1）')
const archToday = s.flowArchive.find((a) => a.bizDate === today)
assert(archToday && archToday.manualRewardNet === 15, '归档留存手动任务奖励净额 +15（签到 +5、视频 +10）')

console.log('— 裁剪后历史对账：无虚假差异 —')
s.runRecon(d2, true)
const b2 = s.reconBillOf(d2)
assert(b2.diffs.openCount === 0, `前日对账无虚假差异（openCount=${b2.diffs.openCount}）`)
assert(b2.diffs.points.residual === 0, 'P1 残差=0（归档净额并入勾稽）')
assert(b2.diffs.tasks.length === 0, 'P2 无缺笔（已发奖励按台账 id 在归档中勾稽）')
s.runRecon(today, true)
const bt = s.reconBillOf(today)
assert(bt.diffs.openCount === 0, `今日对账无虚假差异（openCount=${bt.diffs.openCount}）`)
assert(bt.diffs.chain === null, 'P3 余额链经锚点衔接连续，重放期末余额==当前可用积分')

console.log('— 已发任务奖励不被重复补发 —')
const ptsX = s.points
const flowsX = s.pointRecords.length
assert(s.reviewRecon(d2) === false, '前日账实相符，复核拦截')
assert(s.compensateRecon(d2) === null, '前日无差异，补偿零操作')
assert(s.points === ptsX && s.pointRecords.length === flowsX, '余额与流水零变动（不重复补发）')
assert(!s.pointRecords.some((p) => p.kind === 'task-comp' && p.refId === 'seed-tc1') &&
  !s.flowArchive.some((a) => a.taskComps.some((t) => t.claimId === 'seed-tc1')),
  '现存与归档中均无针对已发奖励的补偿流水')

console.log('— 真实差异仍检出并补偿（归档不掩盖真账）—')
s.runRecon(d1, true)
const b1 = s.reconBillOf(d1)
assert(b1.diffs.points.residual === 5 && b1.diffs.tasks.some((t) => t.claimId === 'seed-tc-gap'),
  '昨日真实漏记 +5 仍准确检出')
s.setRole('operator')
s.reviewRecon(d1, '裁剪后复核：差异属实')
const ptsY = s.points
const r = s.compensateRecon(d1)
assert(r && r.pointDelta === 5 && s.points === ptsY + 5, '补偿 +5 并同步余额')
assert(s.reconBillOf(d1).status === 'compensated', '昨日差异单补偿平账')
assert(s.compensateRecon(d1) === null, '已平账单重复补偿幂等拦截')
s.runRecon(today, true)
assert(s.reconBillOf(today).diffs.chain === null, '补偿入账后余额链仍连续')

console.log('— 统计与领奖台账一致 —')
// pointsIssued 口径：正额非返还流水（含对账补偿 +5，与修复前口径一致）；关键是不随裁剪缩水
assert(s.dashboard.pointsIssued === issued0 + 15 + 160 + 5,
  `累计发放积分含归档留存、不随裁剪缩水（${s.dashboard.pointsIssued} = ${issued0} + 任务15 + 压测160 + 补偿5）`)
assert(s.taskClaims.length === claims0, '领奖台账不因裁剪/对账变动')
assert(s.dashboard.taskSettlements === claims0, '看板任务结算量与台账一致')
assert(s.dashboard.reconCompensated === comp0 + 5, `累计补偿积分 +5（实际 ${s.dashboard.reconCompensated}）`)

console.log(failed ? `\n共 ${failed} 项失败` : '\n全部通过 🎉')
process.exit(failed ? 1 : 0)
