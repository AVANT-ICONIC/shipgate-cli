// SPDX-License-Identifier: AGPL-3.0-or-later
import { violation } from '../violations.mjs';

export function analyzeBudgets(violations, config) {
  const counts={};
  for (const item of violations) counts[item.rule]=(counts[item.rule]||0)+1;
  const out=[];
  for (const [rule,max] of Object.entries(config.budgets || {})) {
    const count=counts[rule]||0;
    if (count>max) out.push(violation('policy/budget-exceeded', [], `Mess budget exceeded for ${rule}: ${count} > ${max}`, `${rule}:max=${max}`));
  }
  return out;
}
