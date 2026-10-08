# 峡谷观测 · KPL / 英雄联盟预测

阿里云 ECS 推荐使用[服务部署说明](服务部署说明.md)：支持 **Alibaba Cloud Linux 4 LTS 64 位**，Git 仓库可保留在 `/root/project/ai-lol`，直接通过 **`http://公网IP:8080/`** 访问。在页面点击即可触发服务器采集并发布新快照，无需 Nginx、前端构建或数据库。另保留[纯静态部署方式](服务器部署说明.md)，此包不依赖 ChatGPT Sites 托管。

可直接部署的中文赛事分析系统。支持王者荣耀 KPL，以及英雄联盟德玛西亚杯、全球总决赛；两种游戏的训练数据、回测、导入数据、自选对阵和分界线各自独立。选择待赛对阵或自建对阵，手动输入时长、总击杀、让人头分界线，查看单局预测、80% 预测区间和大小概率。近期比赛表现分别列出双方各自最近 20 场系列赛，点击可展开逐局时长、击杀和击杀差；该列表不受预测回看天数和局序筛选影响。

## 数据

内置 2026 年官方数据快照：截至北京时间 2026-10-08，328 场、1,392 局、18 场未来赛程。其中 KPL 春季赛、夏季赛、年度总决赛 290 场 / 1,204 局；挑战者杯 38 场 / 188 局。建模默认排除挑战者杯，可在预测工作台切换。

来源为 https://pvp.qq.com/matchdata/index.html 及页面公开使用的 `https://prod.comp.smoba.qq.com/leaguesite/` 接口。不需要账户、令牌或 Cookie。逐局按队伍 ID 对齐红蓝方，检查击杀数与选手合计以及局数、胜局与系列比分。数据覆盖完整不表示每条源站记录已经人工核对。官网接口将来可能调整，失败或缺失须查看报告；维护时按部署流程保留上一份线上快照。

### 英雄联盟

2026 年 LoL 历史样本共 2,535 局、60 队：原有腾讯官方 LPL、MSI、全球先锋赛及德杯 837 局，加 ChainCC 公开的 LCK 502、LEC 383、LCS 260、LCP 283、CBLOL 270 局。五个新增赛区的 1,697 局通过 Riot 官方赛程核对，归属 681 场完整系列赛；LCK 8 月 1 日 GEN–DK 缺第一局，第二局保留逐局数据但不判定整场胜负。LCK 覆盖 502/503 局，其余四赛区与官方已结束局数一致。全库共有 981 场完整关联系列赛及 1 局未完整关联记录。

新增数据采用 [ChainCC 公开数据集](https://chaincc.lol/free/data)，[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) 许可；保留署名：ChainCC. League of Legends esports match dataset. chaincc.lol/free/data。该发布者使用 Oracle’s Elixir 等公开数据，具体说明见[数据方法](https://chaincc.lol/about/methodology)。团队与选手 CSV 按 game_id 和 side 关联，五名选手的明确位置、英雄和击杀合计均与团队行交叉核验。逐局字段来源见 duration_source_url、kills_source_url、draft_source_url，原始文件哈希及采集时刻保存在 metadata.globalRegions 中。页面不会将缺失数据补为模拟结果。

Worlds 尚未公布的对阵保留“待定”，不产生数值预测。可选择“自选 / 假设对阵”提前分析两队；官方确认对阵与假设对阵明确区分。无历史样本时不生成预测，较少样本显示提示，近20场不足20场时只显示实际收录记录。世界赛日程来自 Riot 公开页面的分页窗口，当前并非全部时段；覆盖情况见 dist/lol-events.json。

原有腾讯与德杯已结束系列的预测截止时间采用首次实际开赛时间（Riot feed 使用初始化帧作为保守起点），结果可用时间采用整场实际结束时间，原计划时间另存 scheduled_at。LoL 不混入 KPL 数据；沿用时间加权、战队攻防与节奏参数收缩的统计基线，尚未校准概率，也未专门控制赛区整体强弱。数据覆盖不等于全球各赛区完整覆盖。

### 英雄联盟两种预测模式

- **赛前预测**：选择双方队伍、预测时间和局序，用当时已经结束的比赛估计时长、总击杀和击杀差，不要求知道英雄。
- **英雄阵容预测**：指定当前第几局，按上路、打野、中路、下路、辅助分别选择双方五个英雄。只选英雄，不选选手；完整阵容确定后才适用。在相同赛前基线上加入“英雄 × 位置”的历史关联修正，并展示基线与修正后的结果。不同局需要重新选择阵容。

目前 2,535 局真实 LoL 样本都具备已核验的双方阵容，共 5,070 套阵容、25,350 次英雄选择。腾讯来源使用该局 `playerInfos.role` 和 `heroId`，Riot 来源使用比赛元数据的 `role` 和 `championId`；先按队伍 ID 对齐红蓝方，再关联英雄。不会把选手 ID、数组顺序、常用位置或英雄类别标签当作实际分路。腾讯一局的选手默认位置与该局位置不一致，使用明确的比赛位置，并在 `metadata.draftCoverage.roleConflicts` 保留核验说明。

英雄中文名称和图标来自官方 Data Dragon 16.20.1，共 173 个英雄；历史样本使用情况随公开数据更新，见英雄目录和覆盖报告。目录版本只用于身份、名称和图标，不代表所有历史比赛使用该版本。样本不足的英雄/位置组合会收缩或回退，不能据此认为陌生组合一定较差。公开比赛中的英雄关联不是因果效果，也不是准确率保证；模型尚未刻画英雄配合/克制、禁选顺序、选手、红蓝方和版本变化。阵容对照回测使用同一批真实对局逐场比较，不能保证未来优于赛前基线。

## 服务启动与页面更新

Python 3.9+，在项目目录执行：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python server.py --host 0.0.0.0 --port 8080
```

访问 `http://服务器公网IP:8080/`，本地测试访问 `http://127.0.0.1:8080/`。8080 需空闲并在安全组放行；原 Nginx 若监听该端口，应先释放。长期运行使用 [systemd 部署步骤](服务部署说明.md#4-启动并设置开机自启)。

完成 systemd 安装后，可在项目目录运行 `bash start.sh` 启动、`bash restart.sh` 重启、`bash stop.sh` 关闭服务。脚本会检查服务所属目录，启动后验证健康状态；无需手动维护 PID。查看日志使用 `sudo journalctl -u kpl-insight -f`，详见[脚本使用说明](服务部署说明.md#41-使用启动重启和关闭脚本)。

首次启动自动生成 `runtime/admin-token`，在服务器读取口令后，在「比赛数据 → 更新服务器数据」中输入。按当前游戏采集，后台显示阶段与日志；成功后发布完整快照，失败保留旧数据。同一时间只执行一个任务。运行数据、缓存和口令都在 Git 忽略的 `runtime/`，不会改写 Git 中的 `dist/*.json`。

这会触发当前公开源采集，不保证源站已经提供全部比赛；德杯时长事实表、世界赛结果接入等原有数据限制仍适用。浏览器导入的 CSV、自选对阵与英雄选择仍保存在当前浏览器。

## 本地预览

使用 Python 3，无须安装前端依赖。在本目录运行：

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory dist
```

打开 http://localhost:4173 。请通过 HTTP 服务运行，不能直接双击 index.html。此命令仅用于静态预览，不提供服务器采集 API。需要页面更新数据时使用上面的服务模式，无需开放 4173 端口。

## 更新数据

**服务模式**下，点击「更新服务器数据」由服务器执行采集、校验并发布，所有访问者可读取更新后的快照；这不是后台定时任务。**纯静态模式**下，「同步官方数据」由浏览器直接读取 KPL 公开接口，结果仅保存在当前浏览器。CSV 可用于备份。以下命令用于手动维护，服务模式会在隔离暂存目录中执行相同流程。

也可以在独立的完整源码暂存副本中更新部署快照（Python 3.9+），核对报告后再发布，勿直接在正在服务的目录内采集：

```sh
python3 update-data.py --year 2026 --output dist/data.json
```

Python 脚本使用标准库；KPL 采集默认 3 个并发，`--workers` 上限为 4，缓存写入本目录 `cache/`，无需把缓存放到站点。部分采集失败时仍会写入候选快照并正常退出，发布前必须检查 `metadata.complete`、`metadata.missing` 并与上一版比较，不能只看退出码。更新静态快照后需重新发布；用户在网页中同步不需要重新发布。

纯静态模式下，英雄联盟网页的“刷新已发布快照”只读取网站数据文件；服务模式提供“更新服务器数据”以触发以下采集流程。手动执行时按顺序更新，任何步骤失败都先查看报告，不发布失败或未核验的产物：

```sh
python3 update-lol-events.py
python3 update-lol-data.py
python3 update-demacia-data.py
python3 merge-lol-data.py --output cache/lol/base-candidate.json
python3 enrich-lol-drafts.py --base-only --input cache/lol/base-candidate.json --output cache/lol/base-enriched.json --previous dist/lol-data.json --catalog-output cache/lol/base-champions.json
python3 update-global-lol-data.py --fetch --base cache/lol/base-enriched.json
```

腾讯/德杯候选先在 cache/lol/ 补齐阵容。`--base-only` 仅对这两个来源暂存核验，不允许直接覆盖发布文件；它保留这两个来源的删局保护，由最后的 global 合并再检查全库旧记录。最终 `update-global-lol-data.py` 下载五赛区 CSV、分页获取 Riot 官方赛程、核对完整系列赛，再重建并替换本来源记录；不会把旧行重复追加。所有校验通过后才写入 dist/lol-data.json，并更新中文英雄目录的历史使用计数。

已有下载缓存时，可用 `python3 update-global-lol-data.py` 离线重放当前快照；或不带 `--fetch` 配合 `--base cache/lol/base-enriched.json` 完成整个暂存流程。默认缓存位于 cache/global-lol/，报告为 coverage-report.json 和 integration-report.json。`--fetch` 使用普通公开 curl 下载，不需要账号或密钥；Riot 赛程最多 3 并发，分页有上限。新增源行校验失败、原始文件哈希不符，或候选丢失已经发布的比赛 ID 时均阻止发布，不用旧缓存静默掩盖下载失败。

采集器以真实 date 年份过滤 2026 年数据，而不是只看源 year 标签：当前原文件有 494 条团队记录的 year=2026、date 却不属于 2026，已排除。不合并源文件中的 LPL 或 EWC，避免重复现有记录或混淆资格赛。Riot 官方查询或公开源格式调整时应修复采集脚本，不能用猜测字段代替。

已有比赛的原始缓存缺失时，脚本仅在比赛 ID、局序和双方队伍 ID 等身份字段完全相同的情况下，保留当前输入或上一份已发布快照中的已核验阵容，并明确报告 `retainedVerifiedMaps`；这不算本次重新核验。原始数据存在但与英雄 ID、队伍、分路等校验冲突时不会回退掩盖问题。新增比赛没有可核验阵容，或候选快照遗漏了原来已核验的比赛时，默认退出码为 2，保留原有发布快照和英雄目录，只写缺失报告。`--allow-partial` 可显式接受缺失或删减并生成不完整结果，缺阵容行会标记 `draft_verified=false`，不参与阵容训练。

只有腾讯/Riot 数据的快照可直接运行 `python3 enrich-lol-drafts.py`；包含五赛区数据的快照请使用上述分阶段流程，或 `python3 update-global-lol-data.py` 重放；`--previous` 可指定另一份已核验快照，默认使用输出文件的旧版本。原始官方英雄目录已保存到 `data-sources/ddragon/16.20.1-zh_CN.json`，不依赖网络也能重建 173 个英雄的中文列表。新增英雄或升级目录时，先从官方 Data Dragon 获取对应版本的 `zh_CN/champion.json`，再用 `--champions-raw 路径` 指定；该参数不会改写历史比赛版本。其余输入/输出和缓存路径可通过 `python3 enrich-lol-drafts.py --help` 查看。

德杯局内时长事实表 demacia-gol-facts.json 已核验到 10 月 7 日；新增比赛须先补充并核验其公开统计。没有事实表的新增局会报告缺失，不用墙钟时差代替局内时长。2 局 Riot 团队聚合击杀与选手和存在差异，采用与 Games of Legends 一致的选手击杀合计，并保留原值与差异说明。

采集器缓存位于 cache/lol/、cache/lol-riot/、cache/lol-schedule/ 与 cache/global-lol/，不进入部署产物。腾讯接口使用官方网页 JavaScript 内公开的应用请求头，运行时获取，不需要用户登录且不保存该值。Riot 赛程从公开 HTML 的结构化数据读取。通过独立暂存副本和版本发布保留上一份线上快照；部分脚本可在存在缺失时正常退出并写入输出，更新后需逐项检查缺失与阵容覆盖报告、运行测试，再按[部署指南](服务器部署说明.md#8-更新赛事数据可选)发布。

纯静态部署发布 `dist/` 即可；服务模式运行 `server.py`，自动提供页面和已发布的运行快照。两种模式都无需数据库，不依赖 Sites 托管。通过 Git 部署服务时，升级代码后重启服务，日常数据更新可直接在网页完成。浏览器 CSV 导入只保存在当前设备，不写回服务器。

## 文件

- `server.py` / `update_service.py`：网页服务、更新鉴权、后台采集与原子发布。
- `start.sh` / `restart.sh` / `stop.sh`：管理已安装的 systemd 服务，共用 `deployment/service-control.sh`。
- `requirements.txt` / `deployment/kpl-insight.service`：服务依赖与 systemd 配置。
- `服务部署说明.md`：Git 原目录、IP:8080 访问与页面更新操作说明。

- `dist/app.js` / `style.css`：预测、数据、回测、方法说明界面。
- `dist/engine.js`：时间加权岭收缩统计模型与 CSV 校验。
- `dist/draft-engine.js`：LoL 英雄/位置修正与基线对照回测。
- `dist/official.js`：官方数据规范化、跨域增量同步。
- `dist/games.js`：多游戏隔离与赛程规范化。
- `dist/lol-data.json` / `lol-events.json`：LoL 历史快照与官方赛程。
- `dist/champions.json`：官方中文英雄目录与图标链接。
- `update-lol-data.py` / `update-lol-events.py`：LoL 历史统计与赛程采集。
- `enrich-lol-drafts.py`：按队伍 ID 补齐腾讯/Riot 逐局英雄阵容，保留已有核验结果并报告缺失。
- `update-global-lol-data.py`：下载、校验、归一化并合并五赛区数据，保留来源署名与观察时间。
- `collect-riot-series.py` / `map-chaincc-series.py`：公开官方赛程分页与完整系列赛匹配。
- `data-sources/ddragon/`：可离线重建中文英雄目录的官方原始数据。
- `dist/data.json`：带逐局来源链接的真实官方快照。
- `update-data.py`：可断点续采的官方数据采集脚本。
- `tests/`：模型与数据集成校验。

## 检查

服务测试（安装服务依赖后，无需真实联网采集）：

```sh
.venv/bin/python -m unittest discover -s tests -p 'test_*.py'
```

模型与前端测试使用 Node.js 20+：

```sh
node --test tests/*.test.mjs
```

## 预测口径

正数让人头表示 A 队让该数值：`A 击杀 − B 击杀 > 让人头值` 才属于超过；等于整数线是走盘。所有预测针对单局；选择第 4 局及以后时，以该局举行作为条件。输入时间默认北京时间。

腾讯与已核验 Riot 实时数据用 available_at 标记整场实际结束时间；只使用目标比赛开赛前已经结束的系列赛。滚动回测同时排除当前系列赛，避免前场尚未结束时读取它的结果。CSV 缺失 available_at 时赛前基线仅按提供的比赛时间近似；相关训练窗口不启用英雄阵容修正，阵容对照回测跳过时间可用性未核验的目标和训练窗口。赛前模式不使用英雄；LoL 阵容模式增加英雄/位置关联修正，仍不控制禁选顺序、完整阵容交互、选手与版本。概率来自历史残差，尚未经过独立概率校准；80% 区间是预测区间，阵容修正不会因训练残差较小而自动缩窄该区间。实际覆盖率请查看回测。模型不是保证命中率的决策服务。

新增五赛区 CSV 没有时区标签或真实结束时间。已关联系列采用官方 UTC **计划**开赛时间（不是实际开赛），未关联记录使用明确标注的保守 UTC 上界；原始日期保存在 source_date_raw。actual_start/actual_end 均为空，不以局内时长推算墙钟结束。available_at 采用完整快照的真实观察时刻，availability_basis=observed_snapshot，backtest_eligible=false：这些数据可用于观察时刻之后的未来预测，不能倒填历史训练，也不作为历史回测评分目标。

CSV 导入会替换当前浏览器中的数据集，先校验再替换；只接受当前游戏的 2026 年记录。LoL 必须填写 game=lol，未指定游戏的旧 CSV 默认为 KPL。bo 可选填 1/3/5/7/9，备份保留整场胜负判定所需赛制；缺失时不猜测完整性。官方原始数据不会被修改。导出文件保留赛事 ID 以支持恢复后正确排除挑战者杯。
