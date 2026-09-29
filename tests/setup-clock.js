// Runs the suite at midday, whatever the wall clock says.
//
// Plenty of tests start a pass "five minutes ago" or ask for a twenty-minute
// visit, and the code rightly files minutes under the day they were spent and
// never lets a pass run past midnight. Run just after midnight, or just before
// it, those tests fail for reasons that have nothing to do with the change
// under test. Shifting the clock rather than freezing it keeps time moving, so
// anything that measures an interval still sees one.
const RealDate = Date;
const noon = new RealDate();
noon.setHours(12, 0, 0, 0);
const OFFSET = noon.getTime() - RealDate.now();

class MiddayDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(RealDate.now() + OFFSET);
    else super(...args);
  }
  static now() { return RealDate.now() + OFFSET; }
}

globalThis.Date = MiddayDate;
