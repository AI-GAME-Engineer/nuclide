/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import invariant from 'assert';
import nuclideUri from '../../commons-node/nuclideUri';
import {runCommand, observeProcessRaw} from '../../commons-node/process';
import {DebugBridge} from './DebugBridge';
import {Observable} from 'rxjs';

import type {AndroidJavaProcess} from './types';
import type {LegacyProcessMessage} from '../../commons-node/process-rpc-types';
import type {NuclideUri} from '../../commons-node/nuclideUri';

export class Adb extends DebugBridge {
  getAndroidProp(device: string, key: string): Observable<string> {
    return this.runShortAdbCommand(device, ['shell', 'getprop', key]).map(s =>
      s.trim(),
    );
  }

  getDeviceArchitecture(device: string): Promise<string> {
    return this.getAndroidProp(device, 'ro.product.cpu.abi').toPromise();
  }

  async getInstalledPackages(device: string): Promise<Array<string>> {
    const prefix = 'package:';
    const stdout = await this.runShortAdbCommand(device, [
      'shell',
      'pm',
      'list',
      'packages',
    ]).toPromise();
    return stdout.trim().split(/\s+/).map(s => s.substring(prefix.length));
  }

  async isPackageInstalled(device: string, pkg: string): Promise<boolean> {
    const packages = await this.getInstalledPackages(device);
    return packages.includes(pkg);
  }

  getDeviceModel(device: string): Promise<string> {
    return this.getAndroidProp(device, 'ro.product.model')
      .map(s => (s === 'sdk' ? 'emulator' : s))
      .toPromise();
  }

  getAPIVersion(device: string): Promise<string> {
    return this.getAndroidProp(device, 'ro.build.version.sdk').toPromise();
  }

  getBrand(device: string): Promise<string> {
    return this.getAndroidProp(device, 'ro.product.brand').toPromise();
  }

  getManufacturer(device: string): Promise<string> {
    return this.getAndroidProp(device, 'ro.product.manufacturer').toPromise();
  }

  async getDeviceInfo(device: string): Promise<Map<string, string>> {
    const infoTable = await this.getCommonDeviceInfo(device);
    const unknownCB = () => null;
    infoTable.set(
      'android_version',
      await this.getOSVersion(device).catch(unknownCB),
    );
    infoTable.set(
      'manufacturer',
      await this.getManufacturer(device).catch(unknownCB),
    );
    infoTable.set('brand', await this.getBrand(device).catch(unknownCB));
    return infoTable;
  }

  getOSVersion(device: string): Promise<string> {
    return this.getAndroidProp(device, 'ro.build.version.release').toPromise();
  }

  installPackage(
    device: string,
    packagePath: NuclideUri,
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    invariant(!nuclideUri.isRemote(packagePath));
    return this.runLongAdbCommand(device, ['install', '-r', packagePath]);
  }

  uninstallPackage(
    device: string,
    packageName: string,
  ): Observable<LegacyProcessMessage> {
    // TODO(T17463635)
    return this.runLongAdbCommand(device, ['uninstall', packageName]);
  }

  forwardJdwpPortToPid(
    device: string,
    tcpPort: number,
    pid: number,
  ): Promise<string> {
    return this.runShortAdbCommand(device, [
      'forward',
      `tcp:${tcpPort}`,
      `jdwp:${pid}`,
    ]).toPromise();
  }

  launchActivity(
    device: string,
    packageName: string,
    activity: string,
    debug: boolean,
    action: ?string,
  ): Promise<string> {
    const args = ['shell', 'am', 'start', '-W', '-n'];
    if (action != null) {
      args.push('-a', action);
    }
    if (debug) {
      args.push('-N', '-D');
    }
    args.push(`${packageName}/${activity}`);
    return this.runShortAdbCommand(device, args).toPromise();
  }

  activityExists(
    device: string,
    packageName: string,
    activity: string,
  ): Promise<boolean> {
    const packageActivityString = `${packageName}/${activity}`;
    const deviceArg = device !== '' ? ['-s', device] : [];
    const command = deviceArg.concat(['shell', 'dumpsys', 'package']);
    return runCommand(this._adbPath, command)
      .map(stdout => stdout.includes(packageActivityString))
      .toPromise();
  }

  async getJavaProcesses(device: string): Promise<Array<AndroidJavaProcess>> {
    const allProcesses = await this.runShortAdbCommand(device, ['shell', 'ps'])
      .map(stdout => {
        const psOutput = stdout.trim();
        return parsePsTableOutput(psOutput, ['user', 'pid', 'name']);
      })
      .toPromise();

    const args = (device !== '' ? ['-s', device] : []).concat('jdwp');
    return observeProcessRaw(this._adbPath, args, {
      killTreeWhenDone: true,
      /* TDOO(17353599) */ isExitError: () => false,
    })
      .catch(error => Observable.of({kind: 'error', error})) // TODO(T17463635)
      .take(1)
      .map(output => {
        const jdwpPids = new Set();
        if (output.kind === 'stdout') {
          const block: string = output.data;
          block.split(/\s+/).forEach(pid => {
            jdwpPids.add(pid.trim());
          });
        }

        return allProcesses.filter(row => jdwpPids.has(row.pid));
      })
      .toPromise();
  }

  async dumpsysPackage(device: string, pkg: string): Promise<?string> {
    if (!await this.isPackageInstalled(device, pkg)) {
      return null;
    }
    return this.runShortAdbCommand(device, [
      'shell',
      'dumpsys',
      'package',
      pkg,
    ]).toPromise();
  }
}

export function parsePsTableOutput(
  output: string,
  desiredFields: Array<string>,
): Array<Object> {
  const lines = output.split(/\n/);
  const header = lines[0];
  const cols = header.split(/\s+/);
  const colMapping = {};

  for (let i = 0; i < cols.length; i++) {
    const columnName = cols[i].toLowerCase();
    if (desiredFields.includes(columnName)) {
      colMapping[i] = columnName;
    }
  }

  const formattedData = [];
  const data = lines.slice(1);
  data.filter(row => row.trim() !== '').forEach(row => {
    const rowData = row.split(/\s+/);
    const rowObj = {};
    for (let i = 0; i < rowData.length; i++) {
      // Android's ps output has an extra column "S" in the data that doesn't appear
      // in the header. Skip that column's value.
      const effectiveColumn = i;
      if (rowData[i] === 'S' && i < rowData.length - 1) {
        i++;
      }

      if (colMapping[effectiveColumn] !== undefined) {
        rowObj[colMapping[effectiveColumn]] = rowData[i];
      }
    }

    formattedData.push(rowObj);
  });

  return formattedData;
}
