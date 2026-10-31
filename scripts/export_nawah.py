#!/usr/bin/env python3
"""Convert pinned Apache-2.0 Nawah weights to ONNX without executing remote Python.
Requires torch 2.6.0, transformers 4.49.0, onnx 1.17.0, onnxruntime 1.24.3.
"""
import os
os.environ['ORT_DISABLE_TELEMETRY'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
import hashlib
import json
from pathlib import Path
import urllib.request
import numpy as np
import torch
from torch import nn
from transformers import BertConfig, BertModel
import onnxruntime as ort
ort.disable_telemetry_events()
ROOT = Path(__file__).resolve().parents[1]
REVISION = 'a603d94f1c32d47fa79deb852e16db51caff70de'
BASE = f'https://huggingface.co/oddadmix/Nawah-Dialect-BERT-6M/resolve/{REVISION}/'
CACHE = ROOT / 'models' / 'nawah-source'
OUT = ROOT / 'generated-assets' / 'nawah'
CACHE.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)
lock=json.loads((ROOT/'nawah-source.lock.json').read_text())
for spec in lock['files']:
    name=spec['file']
    target = CACHE/name
    if not target.exists():
        print('Fetching',name,flush=True)
        with urllib.request.urlopen(BASE+name,timeout=90) as src, target.open('wb') as dst:
            while block := src.read(1024*1024): dst.write(block)
    data=target.read_bytes()
    if len(data)!=spec['bytes'] or hashlib.sha256(data).hexdigest()!=spec['sha256']:
        raise RuntimeError('Source integrity mismatch: '+name)
config = BertConfig.from_dict(json.loads((CACHE/'config.json').read_text()))
config._attn_implementation = 'eager'
labels = json.loads((CACHE/'labels.json').read_text())['labels']
class Classifier(nn.Module):
    def __init__(self):
        super().__init__()
        self.backbone = BertModel(config)
        h=config.hidden_size
        self.classifier=nn.Sequential(nn.Linear(h,h),nn.GELU(),nn.Linear(h,len(labels)))
    def forward(self,input_ids,attention_mask):
        hidden=self.backbone(input_ids=input_ids,attention_mask=attention_mask).last_hidden_state
        mask=attention_mask.unsqueeze(-1).to(hidden.dtype)
        return self.classifier((hidden*mask).sum(1)/mask.sum(1).clamp(min=1.0))
model=Classifier()
model.load_state_dict(torch.load(CACHE/'dialect_model.pt',map_location='cpu',weights_only=True))
model.eval()
ids=torch.tensor([[10,20,30,40]],dtype=torch.long)
mask=torch.ones_like(ids)
path=OUT/'model.onnx'
with torch.no_grad():
    torch.onnx.export(model,(ids,mask),str(path),input_names=['input_ids','attention_mask'],output_names=['logits'],dynamic_axes={'input_ids':{1:'tokens'},'attention_mask':{1:'tokens'}},opset_version=17,do_constant_folding=True)
    expected=model(ids,mask).numpy()
session=ort.InferenceSession(str(path),providers=['CPUExecutionProvider'])
actual=session.run(None,{'input_ids':ids.numpy(),'attention_mask':mask.numpy()})[0]
np.testing.assert_allclose(actual,expected,atol=1e-4,rtol=1e-4)
from tokenizers import Tokenizer
import re
tokenizer=Tokenizer.from_file(str(CACHE/'tokenizer.json'))
samples=['انا رايح السوق دلوقتي واجيب حاجات من هناك', 'كيف حالك؟ أنا بخير. 123 ABC', 'أَنَا أَتَكَلَّمُ العَرَبِيَّةَ', 'نحن نتحدث اليوم عن العمل والأسرة والأصدقاء ونحتاج إلى فهم بعضنا بشكل أفضل في الحديث اليومي دون أن نغير معنى الكلام أو ننسى الأسماء والأرقام والمواعيد المتفق عليها']
fixtures=[]
for text in samples:
    normal=re.sub(r'[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]','',text)
    tokens=tokenizer.encode(normal,add_special_tokens=False).ids[:192]
    fixtures.append({'text':text,'ids':tokens})
    x=torch.tensor([tokens]);m=torch.ones_like(x)
    with torch.no_grad(): expected=model(x,m).numpy()
    actual=session.run(None,{'input_ids':x.numpy(),'attention_mask':m.numpy()})[0]
    np.testing.assert_allclose(actual,expected,atol=1e-4,rtol=1e-4)
(ROOT/'tests/fixtures').mkdir(exist_ok=True)
(ROOT/'tests/fixtures/nawah-tokens.json').write_text(json.dumps(fixtures,ensure_ascii=False,indent=2)+'\n')
for name in ['tokenizer.json','labels.json','README.md']:
    (OUT/name).write_bytes((CACHE/name).read_bytes())
(OUT/'LICENSE').write_bytes((ROOT/'docs/licenses/Nawah-Apache-2.0.txt').read_bytes())
files=[]
for name in ['model.onnx','tokenizer.json','labels.json']:
    data=(OUT/name).read_bytes();files.append({'file':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
(OUT/'manifest.json').write_text(json.dumps({'schema':1,'source':'oddadmix/Nawah-Dialect-BERT-6M','revision':REVISION,'license':'Apache-2.0','minimumWords':25,'maxTokens':192,'files':files},indent=2)+'\n')
print('Verified ONNX/PyTorch logit parity. Pack:', OUT,flush=True)
