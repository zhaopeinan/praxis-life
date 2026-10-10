# 备份恢复演练

> 没验证过的备份不算备份。本文只有两件事：怎么演练（不碰线上），和真出事时怎么恢复。

## 备份里有什么

每日 02:00（北京时间）由应用自动执行，打包内容：

- `duowei.db`（WAL checkpoint 后的快照）+ `duowei.db-wal` / `duowei.db-shm`
- `pepper`（令牌/验证码签名用，丢了会导致所有令牌失效）
- `uploads/`（附件目录，存在时才会打进包）

归档命名 `zhixing-YYYYMMDD-HHMMSS.tar.gz`，经 WebDAV 上传到坚果云 `/知行人生备份`。
远端保留策略：最近 7 份 + 最近 12 个月每月各留最新一份。

## 一键演练（推荐每月一次）

在服务器上执行（脚本在仓库 `scripts/restore-drill.sh`）：

```bash
bash /opt/duowei-src/scripts/restore-drill.sh
```

做的事：从坚果云取最新备份 → 解包到临时目录 → 校验包结构与 SQLite `integrity_check`
→ 打印快照与线上库的空间/表/记录/文档条数对比。全程只读，不触碰线上数据。

需要把备份真正解包出来看一眼时：

```bash
bash /opt/duowei-src/scripts/restore-drill.sh --restore-to /tmp/duowei-restore
```

## 真实恢复（灾难恢复）

前提：服务器还在、容器数据损坏或误删；坚果云上有可用备份。

1. **停止写入并保护现场**

   ```bash
   podman stop duowei
   mv /opt/duowei/data /opt/duowei/data.broken.$(date +%Y%m%d-%H%M%S)
   mkdir -p /opt/duowei/data
   ```

2. **取回备份并解包**

   ```bash
   bash /opt/duowei-src/scripts/restore-drill.sh --restore-to /tmp/duowei-restore
   ```

3. **恢复到数据目录**（`duowei.db*`、`pepper`、`uploads`）

   ```bash
   cp -a /tmp/duowei-restore/duowei.db /tmp/duowei-restore/duowei.db-wal /tmp/duowei-restore/duowei.db-shm /opt/duowei/data/ 2>/dev/null || true
   cp -a /tmp/duowei-restore/duowei.db /opt/duowei/data/
   cp -a /tmp/duowei-restore/pepper /opt/duowei/data/ 2>/dev/null || true
   cp -a /tmp/duowei-restore/uploads /opt/duowei/data/ 2>/dev/null || true
   ```

4. **起容器并验收**

   ```bash
   podman start duowei
   curl -s http://127.0.0.1:8787/api/health          # {"ok":true}
   curl -s http://47.122.123.1/api/health            # {"ok":true}
   ```

   然后在网页里抽查：能登录、空间与记录条数与备份时间点一致、文档能打开、附件能下载。

5. **善后**：确认无误前不要删除 `data.broken.*` 目录；恢复成功后把这次演练/恢复记到下方表格。

## 演练记录

| 日期 | 备份文件 | 大小 | 结果 | 说明 |
|------|----------|------|------|------|
| 2026-10-10 | zhixing-20261009-180016.tar.gz | 212K | 通过 | 首次演练：包内含 duowei.db + pepper + uploads/，SQLite integrity_check 通过；快照 4 空间 / 5 表 / 94 记录 / 38 文档，与线上一致。 |
