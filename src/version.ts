/**
 * 语义化版本比较（对齐 VS Code 内置扩展更新判断：semver 规则）。
 *
 * 规则：
 * - 主/次/补丁数字段逐位比较，缺位视为 0（兼容 1.2 / 1.2.3.4 等形态）。
 * - 预发布后缀（-alpha.1）低于正式版；同段内数字 < 字母，数字按数值比较，字母按字典序。
 * - 构建元数据（+build）不参与比较。
 * - 任意一侧无法解析为合法版本号时，退化为字符串比较（对齐 VS Code：无效版本按字符串序）。
 */

interface ParsedVersion {
  nums: number[];
  prerelease: string[];
}

function parse(v: string): ParsedVersion | null {
  const s = String(v).trim();
  if (!s) {
    return null;
  }
  const withoutBuild = s.split('+')[0];
  const dashIdx = withoutBuild.indexOf('-');
  const core = dashIdx >= 0 ? withoutBuild.slice(0, dashIdx) : withoutBuild;
  const pre = dashIdx >= 0 ? withoutBuild.slice(dashIdx + 1) : '';
  const numsStr = core.split('.');
  const nums: number[] = [];
  for (const n of numsStr) {
    if (!/^\d+$/.test(n)) {
      return null;
    }
    nums.push(Number(n));
  }
  if (!nums.length) {
    return null;
  }
  return { nums, prerelease: pre ? pre.split('.') : [] };
}

function compareParsed(pa: ParsedVersion, pb: ParsedVersion): number {
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0;
    const nb = pb.nums[i] ?? 0;
    if (na !== nb) {
      return na > nb ? 1 : -1;
    }
  }
  if (pa.prerelease.length === 0 && pb.prerelease.length === 0) {
    return 0;
  }
  if (pa.prerelease.length === 0) {
    return 1;
  }
  if (pb.prerelease.length === 0) {
    return -1;
  }
  const preLen = Math.max(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < preLen; i++) {
    const xa = pa.prerelease[i];
    const xb = pb.prerelease[i];
    if (xa === undefined) {
      return -1;
    }
    if (xb === undefined) {
      return 1;
    }
    if (xa === xb) {
      continue;
    }
    const na = /^\d+$/.test(xa);
    const nb = /^\d+$/.test(xb);
    if (na && nb) {
      return Number(xa) > Number(xb) ? 1 : -1;
    }
    if (na) {
      return -1;
    }
    if (nb) {
      return 1;
    }
    return xa > xb ? 1 : -1;
  }
  return 0;
}

/**
 * 比较两个版本号：
 * 返回 >0 表示 a 更高，<0 表示 b 更高，=0 表示相等。
 */
export function compareVersions(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) {
    return compareParsed(pa, pb);
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
