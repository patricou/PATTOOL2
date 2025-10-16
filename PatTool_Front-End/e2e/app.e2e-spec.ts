import { SportpatPage } from './app.po';

describe('sportpat App', () => {
  let page: SportpatPage;

  beforeEach(() => {
    page = new SportpatPage();
  });

  it('should display message saying app works', () => {
    page.navigateTo();
    expect(page.getParagraphText()).toEqual('app works!');
  });
});
