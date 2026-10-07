import { findMentions } from './mentions';

const people = [
  { id: '1', name: 'Staff One' },
  { id: '2', name: 'Ann' },
  { id: '3', name: 'Annabel Lee' },
];

describe('findMentions', () => {
  it('matches full names regardless of case', () => {
    expect(findMentions('Please check, @staff one.', people)).toEqual([
      people[0],
    ]);
  });

  it('does not match a name that is only the start of a longer word', () => {
    expect(
      findMentions('Thanks @Annabel Lee', people).map((p) => p.id),
    ).toEqual(['3']);
  });

  it('requires the @ sign and a clean boundary before it', () => {
    expect(findMentions('Staff One did this', people)).toEqual([]);
    expect(findMentions('mail@Ann', people)).toEqual([]);
  });

  it('finds several people once each', () => {
    expect(
      findMentions('@Ann and @Staff One, @Ann again', people).map((p) => p.id),
    ).toEqual(['1', '2']);
  });
});
