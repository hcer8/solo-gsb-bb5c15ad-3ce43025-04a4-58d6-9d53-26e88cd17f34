"""端到端冒烟测试：通过 HTTP API 覆盖主要业务路径。"""
import json
import sys
import urllib.request
import urllib.error

BASE = "http://127.0.0.1:8000"
PASS, FAIL = 0, 0


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req) as resp:
            text = resp.read().decode()
            return resp.status, json.loads(text) if text else None
    except urllib.error.HTTPError as e:
        text = e.read().decode()
        try:
            return e.code, json.loads(text)
        except json.JSONDecodeError:
            return e.code, text


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ {name}  {detail}")


# ---------- 1. 示例①：氰化钾→盐酸→乙醇 ----------
print("【场景1】氰化物酸化（应第 2 步严重中止）")
s, r = call("POST", "/api/plans/1/simulate?persist=false")
check("HTTP 200", s == 200, s)
check("status=danger", r["status"] == "danger", r["status"])
check("halted=True", r["halted"] is True)
fd = r["first_danger"]
check("首次危险在第 1 步(0基)", fd["step"] == 1, fd)
check("冲突对象为第 0 步氰化钾", fd["conflicts_with_step"] == 0 and fd["conflicts_with_reagent"] == "氰化钾")
check("命中 R001", fd["rule_id"] == "R001")
check("含反应方程式", "HCN" in fd["reaction"])
check("含机理依据", len(fd["rationale"]) > 20)
check("含参考文献", len(fd["references"]) >= 1)
check("受影响步骤=[1,2]", r["affected_steps"] == [1, 2], r["affected_steps"])
check("阻断步骤=[2]", r["blocked_steps"] == [2], r["blocked_steps"])
states = [t["state"] for t in r["timeline"]]
check("时间轴状态 ok/danger/blocked", states == ["ok", "danger", "blocked"], states)
f0 = r["findings"][0]
check("finding 可追溯双向类别", f0["incoming_category"] == "strong_acid"
      and f0["existing_category"] == "cyanide", f0)

# ---------- 2. 示例②：铵盐→碱→次氯酸钠 ----------
print("【场景2】铵盐中和后加 84（先警示后严重）")
s, r = call("POST", "/api/plans/2/simulate?persist=false")
check("status=danger", r["status"] == "danger")
check("第 1 步 medium 警示后继续", r["timeline"][1]["state"] == "warning")
med = [f for f in r["findings"] if f["severity"] == "medium"]
check("R015 氨气警示命中", any(f["rule_id"] == "R015" for f in med), med)
check("首次危险在第 2 步 R016 氯胺", r["first_danger"]["step"] == 2
      and r["first_danger"]["rule_id"] == "R016", r["first_danger"])

# ---------- 3. 安全方案（无类别临时试剂 + 普通盐）----------
print("【场景3】安全配液（应 safe）")
s, reagents = call("GET", "/api/reagents")
nacl = next(x for x in reagents if x["name"] == "氯化钠")
plan = {
    "name": "测试-安全盐水",
    "steps": [
        {"order_index": 0, "reagent_id": nacl["id"], "time_offset_min": 0, "amount_ml": 100},
        {"order_index": 1, "reagent_name": "纯水", "categories": [], "time_offset_min": 5, "amount_ml": 50},
    ],
}
s, r = call("POST", "/api/plans/simulate-dry", plan)
check("dry-run 200", s == 200, s)
check("status=safe", r["status"] == "safe", r)
check("无 finding", r["summary"]["findings"] == 0)

# ---------- 4. 自定义临时类别 + 规则全链路 ----------
print("【场景4】自定义规则与临时试剂")
s, r = call("POST", "/api/rules", {
    "id": "C001", "source": "azide", "target": "strong_acid",
    "directional": False, "severity": "high",
    "title": "叠氮化物遇酸生成易爆叠氮酸",
    "reaction": "N3- + H+ -> HN3",
    "rationale": "叠氮酸剧毒且对震动敏感易爆炸。",
    "references": ["测试文献 1"],
})
check("创建自定义规则", s == 201, (s, r))
plan = {
    "name": "测试-叠氮",
    "steps": [
        {"order_index": 0, "reagent_name": "叠氮化钠", "categories": ["azide"]},
        {"order_index": 1, "reagent_name": "稀盐酸", "categories": ["strong_acid"]},
    ],
}
s, r = call("POST", "/api/plans/simulate-dry", plan)
check("自定义规则即时生效", r["status"] == "danger" and r["first_danger"]["rule_id"] == "C001")

# 有向规则：source 类别"被加入"已含 target 的体系时才触发（与加液顺序相关）
s, _ = call("POST", "/api/rules", {
    "id": "C002", "source": "cat_x", "target": "cat_y",
    "directional": True, "severity": "high", "title": "有向测试",
})
s, r = call("POST", "/api/plans/simulate-dry", {
    "name": "测试-有向反向",
    "steps": [
        {"order_index": 0, "reagent_name": "X", "categories": ["cat_x"]},
        {"order_index": 1, "reagent_name": "Y", "categories": ["cat_y"]},
    ],
})
check("有向规则：target 后加入不命中", r["status"] == "safe", r["status"])
s, r = call("POST", "/api/plans/simulate-dry", {
    "name": "测试-有向正向",
    "steps": [
        {"order_index": 0, "reagent_name": "Y", "categories": ["cat_y"]},
        {"order_index": 1, "reagent_name": "X", "categories": ["cat_x"]},
    ],
})
check("有向规则：source 后加入命中", r["status"] == "danger", r["status"])

# ---------- 5. 方案 CRUD + 持久化推演 + 导出 + 记录 ----------
print("【场景5】方案保存 / 推演落盘 / JSON 导出 / 记录")
s, saved = call("POST", "/api/plans", {
    "name": "测试-持久化",
    "description": "e2e",
    "steps": [
        {"order_index": 0, "reagent_name": "硫化钠临时", "categories": ["sulfide"], "time_offset_min": 0, "amount_ml": 10},
        {"order_index": 1, "reagent_name": "盐酸临时", "categories": ["strong_acid"], "time_offset_min": 2, "amount_ml": 5},
        {"order_index": 2, "reagent_name": "水", "categories": [], "time_offset_min": 9, "amount_ml": 100},
    ],
})
check("创建方案", s == 201 and saved["id"] > 0, (s, saved))
pid = saved["id"]
check("步骤类别快照回显", saved["steps"][0]["categories"] == ["sulfide"], saved["steps"][0])

s, r = call("POST", f"/api/plans/{pid}/simulate?persist=true")
check("推演成功", s == 200)
check("返回 run_id", r.get("run_id") is not None)
run_id = r["run_id"]
check("R002 H2S 命中", r["first_danger"]["rule_id"] == "R002")
check("第 3 步被阻断", r["blocked_steps"] == [2])

s, exported = call("GET", f"/api/plans/{pid}/export")
check("导出 JSON 含完整结构", s == 200
      and {"engine", "rule_revision", "status", "first_danger", "timeline", "findings"} <= set(exported),
      s)

s, runs = call("GET", "/api/runs")
check("推演记录列表", s == 200 and any(x["id"] == run_id for x in runs))
s, one = call("GET", f"/api/runs/{run_id}")
check("记录详情可取回", s == 200 and one["first_danger"]["rule_id"] == "R002")
s, one_exp = call("GET", f"/api/runs/{run_id}/export")
check("记录可导出", s == 200 and one_exp["run_id"] == run_id)

s, _ = call("PUT", f"/api/plans/{pid}", {"name": "测试-持久化-改名"})
check("方案更新", s == 200, s)
s, _ = call("DELETE", f"/api/plans/{pid}")
check("方案删除", s == 204, s)

# ---------- 6. 试剂 CRUD 与引用保护 ----------
print("【场景6】试剂档案与引用保护")
s, rg = call("POST", "/api/reagents", {
    "name": "测试试剂A", "cas": "1-2-3", "state": "liquid",
    "categories": ["oxidizer", "custom_cat"],
})
check("创建试剂", s == 201, (s, rg))
rid = rg["id"]
s, _ = call("POST", "/api/plans", {
    "name": "测试-占用试剂",
    "steps": [{"order_index": 0, "reagent_id": rid}],
})
pid2 = _["id"]
s, err = call("DELETE", f"/api/reagents/{rid}")
check("被引用试剂拒绝删除", s == 409, s)
call("DELETE", f"/api/plans/{pid2}")
s, _ = call("DELETE", f"/api/reagents/{rid}")
check("解除引用后可删除", s == 204, s)
s, err = call("POST", "/api/plans/simulate-dry", {"name": "x", "steps": []})
check("空步骤被拒绝", s == 422, s)

# ---------- 7. 规则停用/启用、内置保护 ----------
print("【场景7】规则维护")
s, _ = call("PATCH", "/api/rules/R001", {"active": False})
check("内置规则可停用", s == 200)
s, r = call("POST", "/api/plans/1/simulate?persist=false")
check("停用后不再命中 R001", not any(f["rule_id"] == "R001" for f in r["findings"]))
s, _ = call("PATCH", "/api/rules/R001", {"active": True})
check("重新启用", s == 200)
s, _ = call("DELETE", "/api/rules/R001")
check("内置规则不可删除", s == 409)
s, _ = call("DELETE", "/api/rules/C001")
s2, _ = call("DELETE", "/api/rules/C002")
check("自定义规则可删除", s == 204 and s2 == 204, (s, s2))

# ---------- 8. 同方案两次推演的版本差异 ----------
print("【场景8】版本差异（同一方案两条记录）")
# 8.1 先在 R001=high 下对方案①落盘一条 danger 记录
s, r1 = call("POST", "/api/plans/1/simulate?persist=true")
check("旧版本推演成功", s == 200 and r1["run_id"] is not None, s)
run_old = r1["run_id"]
check("旧版本 danger / R001", r1["status"] == "danger" and r1["first_danger"]["rule_id"] == "R001")

# 8.2 把 R001 降级为 medium，再推演 → warning（第 1 步警示，第 2 步恢复执行）
s, _ = call("PATCH", "/api/rules/R001", {"severity": "medium"})
check("R001 降级为 medium", s == 200)
s, r2 = call("POST", "/api/plans/1/simulate?persist=true")
check("新版本推演成功", s == 200)
run_new = r2["run_id"]
check("新版本 status=warning", r2["status"] == "warning", r2["status"])
check("新版本无首次危险", r2["first_danger"] is None)
check("新版本阻断步骤为空", r2["blocked_steps"] == [], r2["blocked_steps"])

# 8.3 差异（参数顺序故意传反，验证服务端按时间归一化）
s, d = call("GET", f"/api/runs/diff?base={run_new}&target={run_old}")
check("差异接口 200", s == 200, s)
check("base/target 自动归一化为旧→新", d["base"]["run_id"] == run_old and d["target"]["run_id"] == run_new,
      (d["base"]["run_id"], d["target"]["run_id"]))
check("两版本记录归属同一方案", d["plan_id"] == 1)
check("状态 danger→warning 且 trend=improved",
      d["status_change"]["changed"] is True
      and d["status_change"]["base"] == "danger"
      and d["status_change"]["target"] == "warning"
      and d["status_change"]["trend"] == "improved", d["status_change"])
check("首次危险发生变化（消失）",
      d["first_danger_change"]["changed"] is True
      and d["first_danger_change"]["base"]["rule_id"] == "R001"
      and d["first_danger_change"]["target"] is None)
sev_entries = [e for e in d["findings"] if e["change"] == "severity_changed"]
check("R001 命中级别 high→medium",
      len(sev_entries) == 1 and sev_entries[0]["rule_id"] == "R001"
      and sev_entries[0]["base"]["severity"] == "high"
      and sev_entries[0]["target"]["severity"] == "medium"
      and sev_entries[0]["step"] == 1 and sev_entries[0]["conflicts_with_step"] == 0,
      sev_entries)
check("对齐条目含反应依据/步骤",
      sev_entries[0]["target"]["reaction"] and sev_entries[0]["incoming_reagent"] == "盐酸"
      and sev_entries[0]["existing_reagent"] == "氰化钾")
check("阻断步骤集合 [2]→[]",
      d["blocked_steps_change"]["changed"] is True
      and d["blocked_steps_change"]["base"] == [2]
      and d["blocked_steps_change"]["target"] == []
      and d["blocked_steps_change"]["removed"] == [2], d["blocked_steps_change"])
check("counts 统计自洽",
      d["counts"]["severity_changed"] == 1
      and sum(d["counts"].values()) == len(d["findings"]), d["counts"])
check("逐步状态对齐：第 1 步 danger→warning / 第 2 步 blocked→ok",
      {row["order_index"]: (row["base_state"], row["target_state"]) for row in d["steps"]}
      == {0: ("ok", "ok"), 1: ("danger", "warning"), 2: ("blocked", "ok")},
      d["steps"])

# 8.4 导出差异 JSON
s, dexp = call("GET", f"/api/runs/diff?base={run_old}&target={run_new}&export=true")
check("差异导出 200 且结构完整", s == 200
      and dexp["kind"] == "labmix-run-diff"
      and {"base", "target", "findings", "status_change", "first_danger_change",
           "affected_steps_change", "blocked_steps_change", "steps", "counts"} <= set(dexp),
      s)

# 8.5 停用 R001 → 命中消失（removed）
s, _ = call("PATCH", "/api/rules/R001", {"active": False})
s, r3 = call("POST", "/api/plans/1/simulate?persist=true")
run_gone = r3["run_id"]
check("停用后 safe", s == 200 and r3["status"] == "safe", (s, r3.get("status")))
s, d2 = call("GET", f"/api/runs/diff?base={run_new}&target={run_gone}")
removed = [e for e in d2["findings"] if e["change"] == "removed"]
check("R001 命中消失（removed）", len(removed) == 1 and removed[0]["rule_id"] == "R001", removed)
check("counts.removed=1", d2["counts"]["removed"] == 1, d2["counts"])

# 8.6 错误约定
s, err = call("GET", f"/api/runs/diff?base={run_old}&target=999999")
check("缺失记录 → 404", s == 404, s)
s, err = call("GET", f"/api/runs/diff?base={run_old}&target={run_old}")
check("同一记录 → 422", s == 422, s)

# 另一个方案（示例②）的记录
s, rb = call("POST", "/api/plans/2/simulate?persist=true")
run_other = rb["run_id"]
s, err = call("GET", f"/api/runs/diff?base={run_old}&target={run_other}")
check("方案不一致 → 409", s == 409, s)

# 无关联方案的预检记录不能参与比较
s, rdry = call("POST", "/api/plans/simulate-dry", {
    "name": "差异-预检",
    "steps": [{"order_index": 0, "reagent_name": "水", "categories": []}],
})
check("预检不产生记录", s == 200 and rdry.get("run_id") is None)

# 还原规则改动
s, _ = call("PATCH", "/api/rules/R001", {"active": True, "severity": "high"})
check("还原 R001", s == 200)

print(f"\n结果：{PASS} 通过，{FAIL} 失败")
sys.exit(1 if FAIL else 0)
