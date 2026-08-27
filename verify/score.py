import json, re, difflib, sys
W="/private/tmp/claude-501/-Users-anxianjingya/31c956b2-1cf3-4794-be84-830ee20c6e4a/scratchpad/restore"
gt=json.load(open(W+"/groundtruth.json"))
VIS=re.compile(r"^\[(图片|表情|Facepalm|Lol|视频|动画表情)\]+$")
gtt=[g for g in gt if not VIS.match(g["text"])]
got=[]
for l in open(sys.argv[1]):
    m=re.match(r"^\[(我|对方)\]\s*(.*)$", l.strip())
    if m: got.append({"who":"me" if m.group(1)=="我" else "them","text":m.group(2)})
def norm(s): return re.sub(r"[\s，。、,.…“”\"']","",s)
used=set(); res=[]
for g in gtt:
    best,bi=0,-1
    for i,x in enumerate(got):
        if i in used: continue
        r=difflib.SequenceMatcher(None,norm(g["text"]),norm(x["text"])).ratio()
        if r>best: best,bi=r,i
    if bi>=0 and best>0.55: used.add(bi); res.append((g,got[bi],best))
    else: res.append((g,None,0))
full=sum(1 for x in res if x[2]>=0.999)
who=sum(1 for g,m,_ in res if m and g["who"]==m["who"])
# 字符级：把还原文本连起来跟标准答案连起来比
a="".join(norm(g["text"]) for g in gtt); b="".join(norm(m["text"]) for g,m,_ in res if m)
charr=difflib.SequenceMatcher(None,a,b).ratio()
print(f"{sys.argv[2]:>10} | 逐条 {full}/{len(gtt)} = {full/len(gtt)*100:5.1f}% | 字符级 {charr*100:5.1f}% | 发言人 {who/len(gtt)*100:5.1f}%")
