// optionsについて。
/**
 * createImage(options_1, options_2, download);
 * では、
 *
 * options_1がgetInfo options
 *
 * options_2がrender options
 */

/**
 * getInfo options
 *
 * @param {number} [leftDay=0]
 * カレンダー左端の曜日
 * 0: 日曜 ～ 6: 土曜
 *
 * @param {'5'|'6'|'auto'} [rowSize='5']
 * カレンダーの段数（header除く）
 * auto の場合は必要行数を自動計算
 *
 * @param {'en'|'EN'|'ja'} [dayLanguage='en']
 * 曜日表示の言語
 *
 * en : SUN, MON ...
 * EN : SUNDAY, MONDAY ...
 * ja : 日, 月 ...
 */


/**
 * render options
 *
 * @param {string|number} [width='90%']
 * カレンダー全体の横幅
 *
 * @param {string} [squareAspect='5 / 4']
 * 日付セルのアスペクト比
 *
 *
 * ===== 色設定 =====
 *
 * @param {string} [saturdayColor='blue']
 * 土曜日の文字色
 *
 * @param {string} [holidayColor='red']
 * 祝日の文字色
 *
 * @param {string} [sundayColor=holidayColor]
 * 日曜日の文字色
 *
 *
 * ===== フォントサイズ =====
 *
 * @param {string} [captionFontSize='4cqw']
 * タイトル（2026年5月など）の文字サイズ
 *
 * @param {string} [dayFontSize='20cqw']
 * 曜日ヘッダー文字サイズ
 *
 * @param {string} [defaultFontSize='30cqmin']
 * 通常の日付文字サイズ
 *
 * @param {string} [extraFontSize='25cqmin']
 * はみ出し日付文字サイズ
 *
 * @param {string} [holidayNameFontSize='9cqmin']
 * 祝日名文字サイズ
 *
 *
 * ===== その他 =====
 *
 * @param {boolean} [holidayName=false]
 * true の場合は祝日名を表示
 */

// japanese-holidays-jsとdom-to-image-more(capture内)を使用。
import JapaneseHolidays from 'https://cdn.jsdelivr.net/npm/japanese-holidays@1.0.10/+esm';

export default class Calendar {
  constructor(year=null, month=null) {
    if (year === null && month === null) this.date = new Date();
    else this.date = Calendar.#getDate(year, month);

    this.cache = {};
    /*this.info = null;
    this.element = null;
    this.url = null;
    this.img = null;*/
  }

  copy() {
    const clone = new Calendar(this.year, this.month);
    
    if (!this.cache) return clone;
    
    const element = this.cache.element ? this.cache.element.cloneNode(true) : null;
    const img = this.cache.img ? this.cache.img.cloneNode(true) : null;
    clone.cache = {
      info: structuredClone(this.cache.info),
      element,
      url: this.cache.url,
      img
    }
    return clone;
  }
  
  static day = {
    en: ['SUN','MON','TUE','WED','THU','FRI','SAT'],
    EN: ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'],
    ja: ['日','月','火','水','木','金','土']
  }
  
  setDate(year, month) {
    this.date = Calendar.#getDate(year, month);
  }
  
  get year() {return this.date.getFullYear()}
  get month() {return this.date.getMonth()+1}
  
  static #getDate(year, month=null, date=null) {
    if (date === null) {
      if (Number.isFinite(year) && Number.isFinite(month))
        return new Date(parseInt(year), parseInt(month)-1);
      else if (year instanceof Date && month === null)
        return year;
      else
        throw new Error("Error at 'checkDate'");
    } else if (Number.isFinite(date)) {
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(date))
        return new Date(parseInt(year), parseInt(month)-1, parseInt(date));
      else if (year instanceof Date && month === null && date === null)
        return year;
      else
        throw new Error("Error at 'checkDate'");
    } else {
      throw new Error("Error at 'checkDate'")
    }
  }
  
  static async getHoliday(year, month, date) {
    const time = Calendar.#getDate(year, month, date);
    
    if (time.getFullYear() < 1948) return new Error('1948年より前の祝日の判定は行えません。');
    const isHoliday = JapaneseHolidays.isHoliday(time);
    return isHoliday ?? null;
  }
  
  nextMonth() {
    this.cache = {};
    this.date.setMonth(this.date.getMonth()+1);
  }

  preMonth() {
    this.cache = {};
    this.date.setMonth(this.date.getMonth()-1);
  }
  
  fileNameFormat() {
    return this.year+'-'+this.month+'_calendar.png';
  }
  
  async getInfo(options={}) {
    if (options.rowSize && !isNaN(options.rowSize) && (options.rowSize < 5 || options.rowSize > 6)){
      return null;
    }
    const leftDay = options.leftDay ?? 0;
    const dayLanguage = options.dayLanguage ?? 'en';
    const dayList = Calendar.day[dayLanguage];
  
    const header = Array.from({length: 7}, (_, i) => [(leftDay+i)%7, dayList[(leftDay+i)%7]]);
    // Dateのmonthは0が1月、1が2月、...
    // 3月を知りたい時、4月0日→3月31日 となって日にちを取れる。
    const maxDate = new Date(this.year, this.month, 0).getDate();
    const preMaxDate = new Date(this.year, this.month-1, 0).getDate();
    // Dayは、0が日曜日、1が月曜日、...
    const startDay = new Date(this.year, this.month-1, 1).getDay();
    const startInd = (startDay+7-leftDay)%7;
  
    // 何段でカレンダーを格納できるか
    const needRow = (startInd+maxDate-1)/7+1 | 0;
  
    const rowSize = options.rowSize ? (options.rowSize == 'auto' ? needRow : parseInt(options.rowSize)) : 5;
    let error;
    // lengthは、その月の日付がギリギリ入るサイズか指定のサイズの大きい方
    const calendar = await Promise.all(
      Array.from({length: 7*Math.max(rowSize, needRow)}, async (_, i) => {
        const row = i/7 | 0;
        const col = i%7;
        let date = i-startInd+1;
        let onMonth = true;
        let thisMonth = this.month;
        if (i < startInd) {
          date = preMaxDate-(startInd-i)+1;
          onMonth = false;
          thisMonth = this.month-1;
        }
        if (onMonth && date > maxDate) {
          date -= maxDate;
          onMonth = false;
          thisMonth = this.month+1;
        }
      
        const day = (leftDay+i)%7;
        let holiday = await Calendar.getHoliday(this.year, thisMonth, date);
        if (holiday instanceof Error) error = holiday;
        if (day == 0 && !holiday) {
          holiday = '';
        }
        const extra = i >= 7*rowSize;
      
        return {
          day,
          date,
          holiday,
          onMonth,
          extra
        }
      })
    );
  
    if (error instanceof Error) throw error;
  
    const meta = {
      year: this.year,
      month: this.month
    }
    const info = {meta, rowSize, header, calendar};
    this.cache = {info};
    return info;
  }
  
  render(options={}) {
    if (!this.cache.info) throw new Error("Error: Please run 'getInfo'")
    const info = this.cache.info;
    const width = options.width ?? '90%';
  
    const saturdayColor = options.saturday ?? 'blue';
    const holidayColor = options.holidayColor ?? 'red';
    const sundayColor = options.sundayColor ?? holidayColor;
    const squareAspect = options.squareAspect ?? '5 / 4';
  
    const captionFont = options.captionFont ?? '4cqw sans-selif';
    const dayFont = options.dayFont ?? '20cqw sans-selif';
    const defaultFont = options.defaultFont ?? '30cqmin sans-selif';
    const extraFont = options.extraFont ?? '25cqmin sans-selif';
    const holidayNameFont = options.holidayNameFont ?? '9cqmin sans-selif';

    const calendarFontFamily = options.calendarFontFamily ?? null;
    
    const holidayName = options.holidayName !== undefined ? options.holidayName : false;
  
    //console.log(JSON.stringify(info))
    const container = document.createElement('div');
    container.classList.add('calendar');
    container.style.display = "inline-block";
    container.style.width = width;
    //container.style.border = '1px solid black';
    container.style.containerType = 'inline-size';
    container.style.position = 'relative';
  
    const caption = document.createElement('div');
    const meta = info.meta;
    caption.innerHTML = meta.year+'年'+meta.month+'月';
    caption.style.textAlign = 'center';
    caption.style.font = captionFont;
    container.appendChild(caption);
  
    const calendar = document.createElement('div');
    if (calendarFontFamily) calendar.style.fontFamily = calendarFontFamily+' !important';
    calendar.style.border = '1px solid black';
    calendar.style.display = 'flex';
    calendar.style.flexDirection = 'column';
    calendar.style.margin = 'auto 10px 10px 10px';
  
    const head = document.createElement('div');
    head.style.display = 'flex';
  
    for (let day of info.header) {
      const div = document.createElement('div');
      div.style.border = '1px solid black';
      div.style.textAlign = 'center';
      div.style.flex = '1';
      div.style.containerType = 'inline-size';
    
      const span = document.createElement('span');
      span.innerHTML = day[1];
      span.style.font = dayFont;
      if (day[0] == 0) 
        span.style.color = sundayColor;
      else if (day[0] == 6)
        span.style.color = saturdayColor;
    
      div.appendChild(span);
      head.appendChild(div);
    }
  
    calendar.appendChild(head);
  
    const body = document.createElement('div');
    body.style.display = 'grid';
    body.style.gridTemplateColumns = 'repeat(7, 1fr)';
  
  
    function addStyle(span, data) {
      if (!data.onMonth) span.style.opacity = '0.3';
      if (data.holiday === '')
        span.style.color = sundayColor;
      else if (data.holiday !== null)
        span.style.color = holidayColor;
      else if (data.day === 6)
        span.style.color = saturdayColor;
    }
    for (let i = 0; i < info.calendar.length; i++) {
      const data = info.calendar[i];
      const div = document.createElement('div');
      div.style.position = 'absolute';
      div.style.display = 'flex';
      div.style.flexFlow = 'column';
      let square = null;
      if (data.extra) {
        div.style.right = '0';
        div.style.bottom = '0';
      
        for (let child of body.children) {
          if (child.dataset.index == String(i-7)) {
            square = child;
            break;
          }
        }
      } else {
        div.style.left = '0';
        div.style.top = '0';
        square = document.createElement('div');
        square.dataset.index = String(i);
        square.style.border = '1px solid black';
        square.style.aspectRatio = squareAspect;
        square.style.position = 'relative';
        square.style.containerType = 'inline-size';
      }
    
      const span = document.createElement('span');
    
      if (data.extra) span.style.textAlign = 'right';
    
      if (data.extra || (i+7 < info.calendar.length && info.calendar[i+7].extra))
        span.style.font = extraFont;
      else
        span.style.font = defaultFont;
      span.innerHTML = data.date;
    
      const holidaySpan = document.createElement('span');
      holidaySpan.style.font = holidayNameFont;
      if (holidayName && data.holiday !== null) holidaySpan.innerHTML = data.holiday;
      holidaySpan.classList.add(data.extra ? 'out' : 'in');
    
      addStyle(span, data);
    
      div.appendChild(span);
      div.appendChild(holidaySpan);
      square.appendChild(div);
      body.appendChild(square);
    }
  
    calendar.appendChild(body);
  
    container.appendChild(calendar);
    this.cache = {info, element: container.cloneNode(true)};
    return this.cache.element;
  }

  // cssが適応されてしまい、カレンダーの見た目が変わってしまうためiframe内で画像を取得する。
  async capture(options = {}) {
    if (!this.cache.info || !this.cache.element) throw new Error("Error: Please run 'getInfo' and 'render'");
  
    const scale = options.scale ?? 4;
    const size = options.size ?? '1000px';
  
    // 一時的な iframe を作成
    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, {
      position: 'fixed',
      top: '0',
      left: '0',
      width: size, // 広さが足りない場合は大きくして。
      height: size,
      visibility: 'hidden',
      pointerEvents: 'none'
    });
    document.body.appendChild(iframe);

    const doc = iframe.contentDocument || iframe.contentWindow.document;
  
    // iframe
    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            html, body { 
              margin: 0;
              padding: 0;
              background: white;
            }
            * { box-sizing: border-box; }
          </style>
        </head>
        <body></body>
      </html>
    `);
    doc.close();
    const cloneElement = this.cache.element.cloneNode(true);
    doc.body.appendChild(cloneElement);

    return new Promise((resolve, reject) => {
      // iframe内のリソース読み込みを待つため少し余裕を持つ
      requestAnimationFrame(async () => {
        try {
          const domtoimage = (await import("https://cdn.jsdelivr.net/npm/dom-to-image-more@3.5.0/+esm")).default;
        
          const dataUrl = await domtoimage.toPng(cloneElement, {
            width: cloneElement.offsetWidth,
            height: cloneElement.offsetHeight,
            scale,
            style: {
              'margin': '0',
              'position': 'static'
            }
          });
          document.body.removeChild(iframe);
        
          this.cache.url = dataUrl;
          resolve(dataUrl);
        } catch (e) {
          if (iframe.parentNode) document.body.removeChild(iframe);
          reject(e);
        }
      });
    });
  }
  
  downloadImg() {
    if (!this.cache.url) throw new Error("Error: Please run 'capture'");
    const link = document.createElement('a');
    link.download = this.fileNameFormat();
    link.href = this.cache.url;
    link.click();
  }

  getImg() {
    if (!this.cache.url) throw new Error("Error: Please run 'capture'");
    const img = document.createElement('img');
    img.src = this.cache.url;
    this.cache = {info: this.cache.info, element: this.cache.element, url: this.cache.url, img};
    return img;
  }
  
  async run(options={}) {
    return new Promise((resolve, reject) => {
      this.getInfo(options.getInfo).then((info) => {
        const element = this.render(options.render);
        // 引数は、ダウンロードをconfirmするか
        this.capture(options.capture).then((url) => {
          const img = this.getImg();
          if (options.download) this.downloadImg();
          resolve({meta: info.meta, element, img, url});
        })
        .catch((error) => {
          reject(error);
        })
      })
      .catch((error) => {
        reject(error);
      })
    });
  }

  static help = `optionsについて。
 * run({ getInfo: ~, render: ~, capture: ~, download: {boolean} });
 * の形でそれぞれのメソッドに対応するoptionsを受け取る。
 * 
 * downloadは、runを実行した際にダウンロードするかどうかをユーザーにconfirmする。

getInfo options
 * @param {number} [leftDay=0]
 * カレンダー左端の曜日
 * 0: 日曜 ～ 6: 土曜
 *
 * @param {'5'|'6'|'auto'} [rowSize='5']
 * カレンダーの段数（header除く）
 * auto の場合は必要行数を自動計算
 *
 * @param {'en'|'EN'|'ja'} [dayLanguage='en']
 * 曜日表示の言語
 *
 * en : SUN, MON ...
 * EN : SUNDAY, MONDAY ...
 * ja : 日, 月 ...

render options
 * @param {string} [width='90%']
 * カレンダー全体の横幅
 *
 * @param {string} [squareAspect='5 / 4']
 * 日付セルのアスペクト比
 *
 *
 * ===== 色設定 =====
 *
 * @param {string} [saturdayColor='blue']
 * 土曜日の文字色
 *
 * @param {string} [sundayColor=holidayColor]
 * 日曜日の文字色
 *
 * @param {string} [holidayColor='red']
 * 祝日の文字色
 *
 * ===== フォントサイズ =====
 *
 * @param {string} [captionFont='4cqw sans-selif']
 * タイトル（2026年5月など）の文字フォント
 *
 * @param {string} [dayFont='20cqw sans-selif']
 * 曜日ヘッダー文字フォント
 *
 * @param {string} [defaultFont='30cqmin sans-selif']
 * 通常の日付文字フォント
 *
 * @param {string} [extraFont='25cqmin sans-selif']
 * 畳んだ日の日付文字フォント
 *
 * @param {string} [holidayNameFont='9cqmin sans-selif']
 * 祝日名文字フォント
 *
 * <任意>
 * @param {string|null} [calendarFontFamily=null]
 * カレンダー内のフォントを一括指定する(captionは除く)
 *
 *
 * ===== その他 =====
 *
 * @param {boolean} [holidayName=false]
 * true の場合は祝日名を表示

capture options
 * @param {number} [scale=4]
 * 画像の解像度(値が大きいほど高解像度)
 *
 * @param {string} [size='1000px']
 * カレンダーを描画する範囲。画像が書ける場合はこの値を大きくする。
`
}
