"""Real model probes. Success requires the requested marker, not merely exit 0."""
import json
import sys
import uuid
import debate as d

provider=sys.argv[1]
marker=provider.upper()+'_SUBSCRIPTION_OK_'+uuid.uuid4().hex[:8]
record={'provider':provider,'time':d.now(),'test_kind':'REAL_MODEL','expected_marker':marker}
try:
    settings={'model':d.CODEBUDDY_MODEL} if provider=='codebuddy' else None
    answer,raw,err=d.model_call(provider,'Reply exactly '+marker+'. Do not use tools or read files.',120,settings=settings)
    record.update(answer=answer,raw=raw,diagnostics=err,passed=answer.strip()==marker)
    if provider=='codebuddy':record.update(model=d.CODEBUDDY_MODEL,execution_metadata=d.execution_metadata(provider,raw,settings))
except Exception as e:
    record.update(passed=False,error=d.redact(str(e)))
    if isinstance(e,d.ProviderError):record.update(error_category=e.category,diagnostic_details=e.details)
path=d.RUNS/'individual-tests';path.mkdir(exist_ok=True)
dest=path/(provider+'-'+uuid.uuid4().hex[:8]+'.json');d.dump(dest,record)
print(json.dumps({'provider':provider,'passed':record['passed'],'answer':record.get('answer'),'error':record.get('error'),'execution_metadata':record.get('execution_metadata'),'saved':str(dest)},ensure_ascii=False))
sys.exit(0 if record['passed'] else 1)
