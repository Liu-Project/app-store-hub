import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ApiClient, AppInfo } from './apiClient';
import { downloadFile } from './netHttp';
import { getProxyUrl } from './config';
import { t } from './i18n';

/** 解析指定版本（缺省为最新版）的 VSIX 下载地址（相对路径补全为绝对 URL） */
export async function resolveVsixUrl(
  client: ApiClient,
  app: AppInfo,
  version?: string
): Promise<string> {
  let url = app.vsixUrl || '';
  if (version) {
    url = (await client.getVsixUrl(app.publisher, app.name, version).catch(() => '')) || url;
  }
  if (url && !/^https?:\/\//i.test(url)) {
    url = `${client.baseUrl}${url}`;
  }
  if (!url) {
    throw new Error(t('noVsixFound', app.displayName));
  }
  return url;
}

/** 下载 VSIX 到临时目录并返回本地路径（安装/自动更新共用） */
export async function downloadVsixToTmp(
  client: ApiClient,
  app: AppInfo,
  version?: string
): Promise<string> {
  const url = await resolveVsixUrl(client, app, version);
  const dir = path.join(os.tmpdir(), 'appstore-hub');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(
    dir,
    `${app.name}-${version ?? app.version}-${crypto.randomBytes(4).toString('hex')}.vsix`
  );
  await downloadFile(url, dest, undefined, getProxyUrl());
  return dest;
}
