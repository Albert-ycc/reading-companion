// 「/」菜单里的动作登记表。功能模块（导读、导图、框选……）在这里登记自己的动作，
// 菜单（slash.js）从这里读。单独成一个小文件，菜单模块写坏了也不影响别的模块登记。
const actions = new Map(); // name -> { name, label, desc, run, order }

// name 是用户在 / 后面敲的词（如「导读」），run(args) 在用户选中时执行
export function registerAction({ name, label = name, desc = "", run, order = 50 }) {
  actions.set(name, { name, label, desc, run, order });
}

export const listActions = () => [...actions.values()].sort((a, b) => a.order - b.order);
