import { BehaviorSubject } from 'rxjs/BehaviorSubject';
import { ConnectableObservable } from 'rxjs/observable/ConnectableObservable';
import { Observable } from 'rxjs/Observable';
import { Subject } from 'rxjs/Subject';
import { Subscription } from 'rxjs/Subscription';

import 'rxjs/add/operator/delay';
import 'rxjs/add/operator/do';
import 'rxjs/add/operator/map';
import 'rxjs/add/operator/filter';
import 'rxjs/add/operator/publish';
import 'rxjs/add/operator/publishReplay';
import 'rxjs/add/operator/distinctUntilChanged';
import 'rxjs/add/operator/retryWhen';
import 'rxjs/add/operator/timeout';

import { Logger } from '../core';

import { DataView } from './data-view';
import { Peripheral } from './peripheral';

const CONNECTION_TIMEOUT = 3000;
const MIN_RECONNECT_DELAY = 500;
const MAX_RECONNECT_DELAY = 5000;

const POLL_COMMAND = DataView.fromString('?');

export enum ControlUnitButton {
  ESC = 1,
  PACE_CAR = 1,
  ENTER = 2,
  START = 2,
  SPEED = 5,
  BRAKE = 6,
  FUEL = 7,
  CODE = 8
}

export class ControlUnit {

  private connection: Subject<ArrayBuffer>;

  private subscription: Subscription;

  private requests = Array<DataView>();

  private data: ConnectableObservable<DataView>;

  private status: Observable<DataView>;

  private state = new BehaviorSubject<'disconnected' | 'connecting' | 'connected'>('disconnected');

  constructor(public peripheral: Peripheral, private logger: Logger) {
    this.connection = this.peripheral.connect({
      next: () => {
        this.connection.next(POLL_COMMAND.buffer);
      }
    });
    // TODO: different timeout for reconnect/polling
    this.data = this.connection.timeout(CONNECTION_TIMEOUT).retryWhen(errors => {
      return this.reconnect(errors);
    }).do(() => {
      if (this.state.value !== 'connected') {
        this.state.next('connected');
      }
    }).do(() => {
      this.poll();
    }).map((data: ArrayBuffer) => {
      return new DataView(data);
    }).publish();
    // like publishBehavior() with no initial value
    this.status = this.data.filter((view) => {
      // TODO: check CRC
      return view.byteLength >= 16 && view.toString(0, 2) === '?:';
    }).publishReplay(1).refCount();
  }

  connect() {
    this.state.next('connecting');
    this.subscription = this.data.connect();
  }

  disconnect() {
    if (this.subscription) {
      this.subscription.unsubscribe();
    }
  }

  getState(): Observable<'disconnected' | 'connecting' | 'connected'> {
    return this.state.asObservable();
  }

  getFuel(): Observable<ArrayLike<number>> {
    return this.status.map((data: DataView) => data.getUint8Array(2, 8));
  }

  getStart(): Observable<number> {
    return this.status.map((data: DataView) => data.getUint4(10));
  }

  getMode(): Observable<number> {
    return this.status.map((data: DataView) => data.getUint4(11));
  }

  getPit(): Observable<number> {
    return this.status.map((data: DataView) => data.getUint8(12));
  }

  getTimer(): Observable<[number, number, number]> {
    return this.data.filter((view: DataView) => {
      // TODO: check CRC
      return view.byteLength >= 12 && view.toString(0, 1) === '?' && view.toString(1, 1) !== ':';
    }).filter(view => {
      const id = view.toString(1, 1);
      if (id < '1' || id > '8') {
        this.logger.warn('Invalid timer data:', view.toString());
        return false;
      } else {
        return true;
      }
    }).map((view) => {
      return [view.getUint4(1) - 1, view.getUint32(2), view.getUint4(10) ];
    }).distinctUntilChanged(
      // guard against repeated timings
      (a, b) => a[0] === b[0] && a[1] === b[1]
    );
  }

  getVersion(): Observable<string> {
    // TODO: timeout, retry?
    const observable = this.data.filter((view) => {
      // TODO: check CRC
      return view.byteLength == 6 && view.toString(0, 1) == '0';
    }).map(view => {
      return view.toString(1, 4);
    }).map(s => {
      return s.replace(/(\d)(\d+)/, '$1.$2')
    });
    this.requests.push(DataView.fromString('0'));
    return observable;
  }

  reset() {
    this.requests.push(DataView.fromString('=10'));
  }

  setLap(value: number) {
    this.setLapHi(value >> 4);
    this.setLapLo(value & 0xf);
  }

  setLapHi(value: number) {
    this.set(17, 7, value);
  }

  setLapLo(value: number) {
    this.set(18, 7, value);
  }

  setPosition(id: number, pos: number) {
    this.set(6, id, pos);
  }

  clearPosition() {
    this.set(6, 0, 9);
  }

  setMask(value: number) {
    this.requests.push(DataView.from(':', value & 0xf, value >> 4));
  }

  setSpeed(id: number, value: number) {
    this.set(0, id, value, 2);
  }

  setBrake(id: number, value: number) {
    this.set(1, id, value, 2);
  }

  setFuel(id: number, value: number) {
    this.set(2, id, value, 2);
  }

  toggleStart() {
    this.trigger(ControlUnitButton.START);
  }

  trigger(button: ControlUnitButton) {
    this.requests.push(DataView.fromString('T' + String.fromCharCode(0x30 | button)));
  }

  private set(address: number, id: number, value: number, repeat = 1) {
    const args = [address & 0x0f, (address >> 4) | (id << 1), value, repeat];
    this.requests.push(DataView.from('J', ...args));
  }

  private poll() {
    const request = this.requests.shift() || POLL_COMMAND;
    this.connection.next(request.buffer);
  }

  private reconnect(errors: Observable<any>) {
    const state = this.state;
    return errors.do(error => {
      this.logger.error('Device error:', error);
    }).scan((count, error) => {
      return state.value === 'connected' ? 0 : count + 1;
    }, 0).do(() => {
      state.next('disconnected');
    }).concatMap(value => {
      return Observable.timer(Math.min(MIN_RECONNECT_DELAY * (1 << value), MAX_RECONNECT_DELAY));
    }).do(() => {
      state.next('connecting');
    });
  }
}
