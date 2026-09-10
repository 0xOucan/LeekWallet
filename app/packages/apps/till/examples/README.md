# A worked payroll file

`payroll-example.csv` is a real file. Import it into the payroll app and it
loads: six people, six salary transfers, four tips transfers, ten confirmations
on the device. The numbers below are the ones the screen will show.

| | |
|---|---|
| Salary | 8,750.00 |
| Tips | 556.00 |
| **Total to send** | **9,306.00** |
| Transactions | 10 (six salary, four tips) |

The addresses in it are fabricated. Point it at a testnet, or replace them.

## The columns

| Column | Required | What it is |
|---|---|---|
| `name` | yes | Whose row this is. **Host-side text only** — see below. |
| `role` | yes | Their job. Also host-side text; it appears in the proposal's reason line. |
| `address` | yes | The recipient. The only field that decides where money goes. |
| `salary` | yes | The wage. May not be zero. |
| `tips` | no | Tips for the period. May be `0`, may be blank, may be missing entirely. |

**A header is required and columns are matched by name.** Any order works;
`name,role,address,tips,salary` is the same file. Nothing is inferred from
position, because `…,salary,tips` and `…,tips,salary` are the same five cells
paying two different figures. An unknown column, a repeated column or a missing
required one refuses the whole file.

`amount` is accepted as the old spelling of `salary`, so files written before
tips existed still load. A file that names both is refused rather than resolved
by precedence.

**Amounts are plain decimals.** No sign, no exponent, no thousands separator,
no hex, no leading dot: `1250.00` and `1250` and `1250.5`, never `1,250`,
`1.25e3` or `-5`. Both amount columns go through the same validator, so a tips
cell can never hold a shape a salary cell could not. A figure with more decimal
places than the token has — `0.0000001` in 6-decimal USDC — is **refused, not
rounded**, at the moment the token is known, which is why you can switch the
token after importing and get a refusal instead of a silently truncated wage.

**Names are printable ASCII.** `Beltran`, not `Beltrán`. This is deliberate and
it is not about character sets: a right-to-left override or a zero-width mark
inside a name can make a rendered row read as a different row than the one that
pays. Widening the set is a one-line change in `src/staff.ts` and should be made
by somebody looking at what a widened set lets a row do to a line of text.

**One bad row refuses the whole file**, naming the line number. There is no
partial import: a payroll that quietly pays five of six people is worse than one
that will not load.

## Filling in tips, shift by shift

The intended loop, and the reason the file is shaped like this:

1. Keep the roster — `name`, `role`, `address`, `salary` — as the stable part.
   It changes when somebody is hired, leaves or gets a raise.
2. At the end of the pay period, work out each person's share of the pooled
   tips however your house rule says, and type it into the `tips` column. That
   is the column that changes every time.
3. Import, and read **all three totals**. Salary reconciles against contracts;
   tips reconcile against the shift's takings. They are checked against
   different things, which is exactly why they are separate numbers.
4. Confirm each transfer on the device. Salary first for each person, then their
   tips.

Somebody who earned no tips gets `0` or a blank cell and **no second
transaction** — nobody is asked to approve a transfer of nothing.

## Why two transactions and not one

Salary and tips are different money. Salary is payroll. Tips are, in most
places a restaurant operates, held in trust for the staff who earned them,
pooled by a rule the employer does not get to invent, and taxed and declared on
a different footing.

Blending them is permanent. A single transfer of 1,412.50 to Ana is a number no
ledger can ever separate again into 1,250.00 of wage and 162.50 of tips. Two
transfers are two entries, each with its own hash, its own timestamp and its own
amount, and an accountant — or a labour inspector, or Ana — can read them apart
a year later.

And two amounts approved separately are auditable in a way one blended number is
not. Approving "1,412.50" tells you nothing about whether the tips inside it
were right. Approving "1,250.00 salary" and then "162.50 tips" is two decisions,
each about a figure that can be checked against something.

This is not a workaround for a missing batch call. If the wallet grew one
tomorrow, these would still be two transfers.

## What the run does not promise

It is **not atomic**. Each leg is proposed in order and a refusal stops the run,
so it can end with some legs sent and some not — including one person's salary
sent and their tips not. That state is shown per person and per leg, because it
is exactly the state somebody has to act on. Rows shown as *sent* are sent; the
app will not run the same registry twice.

*Sent* also never means *paid*: a transaction hash is a transaction accepted for
broadcast, and this app does not watch for its inclusion.
