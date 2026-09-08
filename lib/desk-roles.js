'use strict';

// WHICH DEVICE IS THE SUPERVISOR'S (#974).
//
// Tyler, 2026-09-08: "i want special permissions for my work pc, so only i see
// it and when someone's been idle etc. i'm the tyler one. for now i still want
// them to see the parked, 503s and work area assigned but the other desk is
// mine to see."
//
// A SUPERVISOR DEVICE is one whose "This device's name" (Settings) folds
// through RemoteAreas.deviceSlug to a slug in SUPERVISOR_SLUGS. The fold is the
// same one that names the device's file on both lanes, so "Tyler", "TYLER" and
// " tyler " are one device here for exactly the reason they are one file there.
// An unnamed device folds to '' and is never a supervisor, which matches the
// off switch every other part of the channel already uses.
//
// THIS IS A UI PERMISSION, NOT A SECURITY BOUNDARY. The data-repo token sitting
// on an admin's profile can read every file in the repo whatever this module
// says, and nothing here encrypts, scopes or withholds a credential. What it
// buys is that the admins' screens stay theirs: the Other desk pane is an audit
// surface built for the supervisor, and putting it on a package handler's cage
// PC shows them their coworkers' work for no reason they can act on. Do not
// reach for this to protect anything that must not be read.
//
// TO ADD A SUPERVISOR: put their device name, folded through deviceSlug (lower
// case, non-alphanumerics to dashes, no leading or trailing dash), in
// SUPERVISOR_SLUGS below and update tests/desk-roles.test.js. Membership is on
// the WHOLE slug, so "Tyler's Desk" (tyler-s-desk) is a different device from
// "Tyler" and needs its own entry.
//
// Dual-loadable with no build step:
// - Browser: window.DeskRoles
// - Node:    require('./lib/desk-roles')

(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DeskRoles = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {

  // Looked up LAZILY, the house pattern (lib/desk-activity.js): in the browser
  // the script tags load in order, and in Node the require resolves on first
  // call, so neither loader needs the dependency present at definition time.
  function dep(name, file) {
    const m = (root && root[name]) || (typeof require === 'function' ? require(file) : null);
    if (!m) throw new Error('DeskRoles dependencies unavailable (need ' + name + ')');
    return m;
  }
  function areasLib() { return dep('RemoteAreas', './remote-areas'); }

  const SUPERVISOR_SLUGS = ['tyler'];

  // isSupervisorDevice(name) -> true when this device's name folds to a
  // supervisor slug. '' (unnamed, or a name that folds to nothing) is false.
  function isSupervisorDevice(name) {
    const slug = areasLib().deviceSlug(name);
    if (!slug) return false;
    return SUPERVISOR_SLUGS.indexOf(slug) !== -1;
  }

  return {
    SUPERVISOR_SLUGS: SUPERVISOR_SLUGS,
    isSupervisorDevice: isSupervisorDevice,
  };
});
