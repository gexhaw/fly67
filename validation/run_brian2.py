# Reference run of the authors' Brian2 model (github.com/philshiu/Drosophila_brain_model, model.py)
# with Brian2 2.9: sugar GRNs at 150 / 100 Hz, N trials, FlyWire v630.
#   cd sources/Drosophila_brain_model && python ../../validation/run_brian2.py 8
import sys, json
sys.path.insert(0,'.')
from model import run_trial, default_params as p
from brian2 import Hz
import pandas as pd
from joblib import Parallel, delayed
comp='./2023_03_23_completeness_630_final.csv'; con='./2023_03_23_connectivity_630_final.parquet'
dfc=pd.read_csv(comp,index_col=0); ids=list(dfc.index); f2i={j:i for i,j in enumerate(ids)}
S=[720575940624963786,720575940630233916,720575940637568838,720575940638202345,720575940617000768,720575940630797113,720575940632889389,720575940621754367,720575940621502051,720575940640649691,720575940639332736,720575940616885538,720575940639198653,720575940620900446,720575940617937543,720575940632425919,720575940633143833,720575940612670570,720575940628853239,720575940629176663,720575940611875570]
out={}
T=int(sys.argv[1])
for hz in [150,100]:
    p['r_poi']=hz*Hz
    res=Parallel(n_jobs=1)(delayed(run_trial)([f2i[s] for s in S],[],[],comp,con,p) for _ in range(T))
    cnt={}
    for r in res:
        for k,v in r.items(): cnt[str(ids[k])]=cnt.get(str(ids[k]),0)+len(v)
    out[f'sugarR_{hz}Hz']={k:v/T for k,v in cnt.items()}
    print(hz,'MN9',out[f'sugarR_{hz}Hz'].get('720575940660219265'),flush=True)
json.dump(out,open('../../validation/brian2_2.9_reference.json','w'))
