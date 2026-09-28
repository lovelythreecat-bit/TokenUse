import {expect,it} from 'vitest';import {DateTime} from 'luxon';
import {makeQuery} from '../src/view';
it('includes today in the last seven calendar days and uses the next midnight as exclusive end',()=>{
 const q=makeQuery({range:'7d',grain:'day',zone:'Asia/Shanghai',customStart:'',customEnd:'',filters:{}},DateTime.fromISO('2026-09-14T10:00:00+08:00'));
 expect(q.start).toBe('2026-09-07T16:00:00.000Z');expect(q.end).toBe('2026-09-14T16:00:00.000Z');expect(q.exactTime).toBe(false);
});
it('includes a date-only ending day but treats an explicit time as exclusive',()=>{
 const options={range:'custom',grain:'day' as const,zone:'Asia/Shanghai',customStart:'2026-09-13',customEnd:'2026-09-14',filters:{}};
 expect(makeQuery(options).end).toBe('2026-09-14T16:00:00.000Z');
 const exact=makeQuery({...options,customEnd:'2026-09-14T18:00'});
 expect(exact.end).toBe('2026-09-14T10:00:00.000Z');expect(exact.exactTime).toBe(true);
});
