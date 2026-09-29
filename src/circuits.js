// Sensory inputs and motor readouts of the virtual fly.
// Neuron sets are resolved against FlyWire v783 annotations (Schlegel et al. 2024) or
// taken verbatim from Shiu et al. 2024 (gustatory receptor neurons).

const SUGAR = [ // labellar sugar GRNs, Shiu et al. 2024 (both hemispheres)
  '720575940624963786', '720575940630233916', '720575940637568838', '720575940638202345', '720575940617000768',
  '720575940630797113', '720575940632889389', '720575940621754367', '720575940621502051', '720575940640649691',
  '720575940639332736', '720575940616885538', '720575940639198653', '720575940620900446', '720575940617937543',
  '720575940632425919', '720575940633143833', '720575940612670570', '720575940628853239', '720575940629176663',
  '720575940611875570', '720575940620589838', '720575940631147148', '720575940608305161', '720575940629388135',
  '720575940630968335', '720575940606801282', '720575940617398502', '720575940616167218', '720575940620296641',
  '720575940627961104',
];
const BITTER = [
  '720575940621778381', '720575940602353632', '720575940617094208', '720575940619197093', '720575940626287336',
  '720575940618600651', '720575940627692048', '720575940630195909', '720575940646212996', '720575940610483162',
  '720575940645743412', '720575940627578156', '720575940622298631', '720575940621008895', '720575940629146711',
  '720575940610259370', '720575940610481370', '720575940619028208', '720575940614281266', '720575940613061118',
  '720575940604027168',
];
const WATER = [
  '720575940612950568', '720575940631898285', '720575940606002609', '720575940612579053', '720575940622902535',
  '720575940616177458', '720575940660292225', '720575940622486922', '720575940613786774', '720575940629852866',
  '720575940625861168', '720575940613996959', '720575940617857694', '720575940644965399', '720575940625203504',
  '720575940630553415', '720575940635172191', '720575940634796536',
];

export const SENSORS = {
  sugar:  { label: 'Sugar GRNs',            sel: { ids: SUGAR } },
  bitter: { label: 'Bitter GRNs',           sel: { ids: BITTER } },
  water:  { label: 'Water GRNs',            sel: { ids: WATER } },
  joL:    { label: 'Johnston’s organ L',    sel: { typePrefix: ['JO-C', 'JO-E'], side: 'left' } },
  joR:    { label: 'Johnston’s organ R',    sel: { typePrefix: ['JO-C', 'JO-E'], side: 'right' } },
  loomL:  { label: 'Looming detectors L',   sel: { types: ['LC4', 'LPLC2'], side: 'left' } },
  loomR:  { label: 'Looming detectors R',   sel: { types: ['LC4', 'LPLC2'], side: 'right' } },
};

export const MOTORS = {
  mn9:    { label: 'MN9 · proboscis',         sel: { types: ['CB0701'] } },
  gf:     { label: 'Giant Fiber · escape',    sel: { types: ['DNp01'] } },
  groom:  { label: 'aDN1 · antennal grooming', sel: { types: ['DNg62'] } },
  walkL:  { label: 'P9 L · forward',          sel: { types: ['DNp09'], side: 'left' } },
  walkR:  { label: 'P9 R · forward',          sel: { types: ['DNp09'], side: 'right' } },
  turnL:  { label: 'DNa02 L · turn',          sel: { types: ['DNa02'], side: 'left' } },
  turnR:  { label: 'DNa02 R · turn',          sel: { types: ['DNa02'], side: 'right' } },
  back:   { label: 'MDN · backward',          sel: { types: ['MDN'] } },
};

export function resolveCircuits(neurons) {
  const res = (defs) => Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, { ...d, idx: neurons.select(d.sel) }]));
  return { sensors: res(SENSORS), motors: res(MOTORS) };
}
