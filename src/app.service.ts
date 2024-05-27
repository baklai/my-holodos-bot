import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Telegraf, Scenes } from 'telegraf';
import { Model } from 'mongoose';

import { User } from './schemas/user.schema';
import { Product } from './schemas/product.schema';

import { TelegramService } from './telegram/telegram.service';
import { ScrapersService } from './scrapers/scrapers.service';
import { TContext } from './telegram/telegram.module';

import { MAIN_COMMANDS, OPERATION_COMMANDS, SYSTEM_COMMANDS } from './common/bot/commands.bot';

@Injectable()
export class AppService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Product.name) private readonly productModel: Model<Product>,
    private readonly scrapersService: ScrapersService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService
  ) {
    this.telegramService.setBotMyCommands([
      ...MAIN_COMMANDS.commands,
      ...OPERATION_COMMANDS.commands
    ]);

    this.telegramService.setBotCommand('start', (ctx: TContext) => this.handlerCommandStart(ctx));
    this.telegramService.setBotCommand('help', (ctx: TContext) => this.handlerCommandHelp(ctx));
    this.telegramService.setBotCommand('about', (ctx: TContext) => this.handlerCommandAbout(ctx));
    this.telegramService.setBotCommand('quit', (ctx: TContext) => this.handlerCommandQuit(ctx));
    this.telegramService.setBotCommand('notice', (ctx: any) => this.handlerCommandNotice(ctx));
    this.telegramService.setBotCommand('admin', (ctx: any) => this.handlerCommandAdmin(ctx));
    this.telegramService.setBotCommand('update', (ctx: any) => this.handlerCommandUpdate(ctx));
    this.telegramService.setBotCommand('donate', (ctx: TContext) => this.handlerCommandDonate(ctx));
    this.telegramService.setBotCommand('statistic', (ctx: TContext) =>
      this.handlerCommandStatistic(ctx)
    );

    this.initSceneAdmin('admin');

    this.initSceneNotice('notice');

    this.telegramService.setOnMessage((ctx: any) => this.onMessage(ctx));

    this.telegramService.setOnСallbackQuery((ctx: any) => this.onСallbackQuery(ctx));

    this.telegramService.botLaunch();
  }

  private groupByMarketAndCategory(data: Record<string, any>) {
    const marketGroups = data.reduce((acc: any, item: any) => {
      if (!acc[item.market]) {
        acc[item.market] = {};
      }
      if (!acc[item.market][item.categoryName]) {
        acc[item.market][item.categoryName] = [];
      }
      acc[item.market][item.categoryName].push(item);
      return acc;
    }, {});

    const result = Object.keys(marketGroups).map(market => {
      const categories = Object.keys(marketGroups[market]).map(category => ({
        categoryName: category,
        products: marketGroups[market][category]
      }));
      return {
        market: market,
        categories: categories
      };
    });

    return result;
  }

  private async onMessage(ctx: any) {
    if (ctx?.update?.message?.text === '❓ Help') {
      return await this.handlerCommandHelp(ctx);
    } else if (ctx?.update?.message?.text === '💸 Donate') {
      return await this.handlerCommandDonate(ctx);
    } else if (ctx?.update?.message?.web_app_data) {
      return await this.handlerWebAppData(ctx);
    } else {
      return await ctx.replyWithHTML('✌️ Дуже цікаво, але я поки що не вмію вести розмову!', {});
    }
  }

  private async onСallbackQuery(ctx: any) {
    const callbackData = ctx.callbackQuery.data;

    switch (callbackData) {
      case 'quit:confirm:yes':
      case 'quit:confirm:cancel':
        return await this.handlerQuitConfirm(ctx);
      default:
        return await ctx.replyWithHTML('💢 <b>Упс!</b> Щось пішло не так!', {});
    }
  }

  private async initSceneNotice(name: string) {
    const scene = new Scenes.BaseScene<any>(name);
    scene.enter(async ctx => {
      const user = await this.userModel.findOne({ userID: ctx.userInfo.userID });

      if (!user || !user?.isAdmin) {
        ctx.reply('💢 <b>Упс!</b> У вас недостатньо повноважень!');
        return ctx.scene.leave();
      }

      const message = [
        '👌 Добре, давайте створемо нове повідомлення!\n\n',
        '👉 Будь ласка, введіть текст повідомлення'
      ];

      ctx.reply(message.join(''));
    });

    scene.on<any>('text', async (ctx: any) => {
      ctx.session.message = ctx.message.text;

      try {
        const users = await this.userModel.find({}).select({ userID: 1 });
        users.forEach(async ({ userID }) => {
          try {
            await this.telegramService.sendMessage(userID, ctx.session.message);
          } catch (err) {
            console.error(err);
            if (err?.response?.error_code === 403) {
              await this.userModel.findOneAndDelete({ userID: userID });
            }
          }
        });
        ctx.reply('💪 Повідомлення відправлено усім користувачам.');
      } catch (err) {
        ctx.reply(`💢 <b>Упс!</b> Щось пішло не так!. Виникла помилка: <i>${err.message}</i>`);
      } finally {
        ctx.scene.leave();
      }
    });

    this.telegramService.registerBotScene(scene);
  }

  private async initSceneAdmin(name: string) {
    const scene = new Scenes.BaseScene<any>(name);
    scene.enter(async ctx => {
      const message = [
        '👌 Добре, давайте отримаємо права адміністратора!\n\n',
        '👉 Будь ласка, введіть секретний ключ'
      ];

      ctx.reply(message.join(''));
    });

    scene.on<any>('text', async (ctx: any) => {
      const secret = this.configService.get<string>('SECRET');
      ctx.session.secret = ctx.message.text;

      if (ctx.session.secret === secret) {
        const user = await this.userModel.findOneAndUpdate(
          { userID: ctx.userInfo.userID },
          { $set: { isAdmin: true } }
        );
        if (user && user?.isAdmin) {
          ctx.reply('👌 Добре, права адміністратора успішно надано!');
        } else {
          ctx.reply('💢 Упс, у правах адміністратора відмовлено!');
        }
      } else {
        ctx.reply('💢 Упс, у правах адміністратора відмовлено!');
      }

      ctx.scene.leave();
    });

    this.telegramService.registerBotScene(scene);
  }

  private async handlerWebAppData(ctx: any) {
    const webAppData = ctx.message.web_app_data.data;

    const { order, price, comment } = JSON.parse(webAppData);

    const message = [];

    if (!order.length) {
      message.push('🗣 <b>Ваш перелік товарів порожній!</b>');

      return await ctx.replyWithHTML(message.join(''), {
        link_preview_options: { is_disabled: true }
      });
    }

    const products = await this.productModel
      .find({ _id: { $in: order.map(({ id }) => id) } })
      .select({
        _id: 1,
        title: 1,
        pricePer: 1,
        priceTitle: 1,
        market: 1,
        categoryName: 1
      })
      .lean()
      .exec();

    if (!products.length) {
      message.push('🗣 <b>Ваш перелік товарів не знайдено!</b>');

      return await ctx.replyWithHTML(message.join(''), {
        link_preview_options: { is_disabled: true }
      });
    }

    const productsCount = products.map((product: Record<string, any>) => {
      return {
        title: product.title,
        pricePer: product.pricePer,
        priceTitle: product.priceTitle,
        market: product.market,
        categoryName: product.categoryName,
        count: order.find(({ id }) => id == product._id)?.count || 0
      };
    });

    const groupProducts = this.groupByMarketAndCategory(productsCount);

    message.push('🔖 <b>Ваш список товарів:</b>\n');

    groupProducts.forEach((markets: Record<string, any>) => {
      message.push(`\n🏷 <b>МАРКЕТ: ${markets.market.toUpperCase()}</b>\n`);
      markets.categories.forEach((category: Record<string, any>) => {
        message.push(`\n<b>${category.categoryName}</b>\n`);
        category.products.forEach((product: Record<string, any>, index: number) => {
          message.push(
            `   <b>${index + 1}</b>. ${product.title} (<b>${
              product.count
            }x</b>) - <i>${product.pricePer} ${product.priceTitle}</i>\n`
          );
        });
      });
    });

    price ? message.push(`\n<b>ВСЬОГО:</b> ₴${price}`) : message.push('');
    comment ? message.push(`\n\n<b>Ваш коментар:</b> <i>${comment}</i>`) : message.push('');

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: { is_disabled: true }
    });
  }

  private async handlerCommandStart(ctx: TContext) {
    const message = [
      `👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!`,
      '\n\n',
      '☝️ Дослідження підтверджують, що покупці зі списком продуктів та покупок витрачають на 15-30% менше грошей у магазинах! ',
      'Грамотно спланований похід до магазину збереже ваш час і позбавить від придбання непотрібних товарів.',
      '\n\n',
      '<i>💪 Я допоможу зробити процес походу до магазину простіше, швидше та найголовніше, ефективніше.</i>',
      '\n\n',
      '👉 Надішліть <b>/help</b> для перегляду списку команд'
    ];

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        resize_keyboard: true,
        keyboard: [
          [
            {
              text: 'Відкрити холодос',
              web_app: { url: this.configService.get<string>('WEB_APP') }
            }
          ],
          [{ text: '❓ Help' }, { text: '💸 Donate' }]
        ]
      }
    });

    const { userID } = ctx.userInfo;

    const user = await this.userModel.findOne({ userID });

    if (user) {
      return await this.userModel.findByIdAndUpdate(user.id, { ...ctx.userInfo });
    } else {
      return await this.userModel.create({ ...ctx.userInfo });
    }
  }

  private async handlerCommandHelp(ctx: TContext) {
    const message = [
      `👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!`,
      '\n\n',
      '☝️ Я можу допомогти Вам створити та керувати списком товарів. Ви можете керувати мною, надіславши наступні команди:',
      '\n\n',
      `${MAIN_COMMANDS.commands.map(item => `/${item.command} - ${item.description}`).join('\n')}\n\n`,
      `<b><i>${OPERATION_COMMANDS.description}</i></b>\n`,
      `${OPERATION_COMMANDS.commands.map(item => `/${item.command} - ${item.description}`).join('\n')}\n\n`
    ];

    const user = await this.userModel.findOne({ userID: ctx.userInfo.userID });

    if (user?.isAdmin) {
      message.push(
        `<b><i>${SYSTEM_COMMANDS.description}</i></b>\n`,
        `${SYSTEM_COMMANDS.commands.map(item => `/${item.command} - ${item.description}`).join('\n')}`
      );
    }

    message.push('\n\n\n', '🚧 <b>Відкрий холодос, для початку</b> 👇');

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        resize_keyboard: true,
        keyboard: [
          [
            {
              text: 'Відкрити холодос',
              web_app: { url: this.configService.get<string>('WEB_APP') }
            }
          ],
          [{ text: '❓ Help' }, { text: '💸 Donate' }]
        ]
      }
    });
  }

  private async handlerCommandAbout(ctx: TContext) {
    const message = [
      `👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!`,
      '\n\n',
      '☝️ <b><i>Холодос</i></b> - це бот, що робить процес походу до магазину простіше, швидше, і найголовніше, ефективніше. Завдяки боту Ви зможете:',
      '\n\n',
      '🔸 <i>швидко створювати та керувати списками покупок, робити їх доступними близьким та знайомим;</i>',
      '\n',
      '🔸 <i>використовувати списки товарів та актуальні ціни найпопулярніших мереж супермаркетів;</i>',
      '\n',
      '🔸 <i>зберігати в чаті сформовані списки, і у Вас у будь-який час є до них доступ як із телефону, із додатку, так і через веб-сайт;</i>',
      '\n\n\n',
      '👉 Надішліть <b>/help</b> для перегляду списку команд',
      '\n\n\n',
      `✌️ Created by <a href=\"${'https://t.me/baklai'}\">Dmitrii Baklai</a> © ${new Date().getFullYear()}.`
    ];

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        resize_keyboard: true,
        keyboard: [
          [
            {
              text: 'Відкрити холодос',
              web_app: { url: this.configService.get<string>('WEB_APP') }
            }
          ],
          [{ text: '❓ Help' }, { text: '💸 Donate' }]
        ]
      }
    });
  }

  private async handlerCommandNotice(ctx: any) {
    return ctx.scene.enter('notice');
  }

  private async handlerCommandAdmin(ctx: any) {
    return ctx.scene.enter('admin');
  }

  private async handlerCommandUpdate(ctx: any) {
    const user = await this.userModel.findOne({ userID: ctx.userInfo.userID });

    if (!user || !user?.isAdmin) {
      return await ctx.reply('💢 <b>Упс!</b> У вас недостатньо повноважень!');
    }

    await this.scrapersService.handleTaskScrape();

    await ctx.reply('👌 Добре, перелік товарів оновлено!');
  }

  private async handlerCommandQuit(ctx: TContext) {
    const message = [`👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!\n\n`];

    const user = await this.userModel.findOne({
      userID: ctx.userInfo.userID
    });

    if (!user) {
      message.push('‼️ Ви не підписані на мене!\n\n');
      message.push('⁉️ Якщо хочете підписатися відправте /start!\n');
      return await ctx.replyWithHTML(message.join(''), {});
    }

    message.push('👌🫣 Добре, давайте відпишу Вас.\n\n');
    message.push('<i>⁉️ Ви впевнені що хочете відписатися від мене?</i>\n\n');
    message.push('👇 Будь ласка, підтвердіть своє наміряння');

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: {
        is_disabled: true
      },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Так 💯 відписатися!',
              callback_data: 'quit:confirm:yes'
            },
            {
              text: 'Ні, не відписуватися!',
              callback_data: 'quit:confirm:cancel'
            }
          ]
        ]
      }
    });
  }

  private async handlerQuitConfirm(ctx: any) {
    const callbackData = ctx.callbackQuery.data;

    const message = [`👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!\n\n`];

    if (callbackData === 'quit:confirm:yes') {
      const user = await this.userModel.deleteOne({
        userID: ctx.userInfo.userID
      });

      if (!user) {
        message.push('‼️ Ви не підписані на мене!\n\n');
        message.push('⁉️ Відправте команду /start щоб підписатися!\n');
        return await ctx.replyWithHTML(message.join(''), {});
      }

      message.push('👌 Добре, ви відписані від боту!');

      return await ctx.replyWithHTML(message.join(''), {});
    } else {
      message.push(
        '👌 Добре, команда була скасована.\n\n',
        '<i>⁉️ Що я ще можу зробити для вас?</i>'
      );
      return await ctx.replyWithHTML(message.join(''), {});
    }
  }

  private async handlerCommandDonate(ctx: TContext) {
    const message = [
      `👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!`,
      '\n\n',
      '👌 Добре, якщо ви вирішили підтримати розвиток боту то не зупиняйтесь!',
      '\n\n',
      '<i>👉 Будь ласка, натисніть кнопку у повідомлені 👇</i>',
      '\n\n',
      '👉 Надішліть <b>/help</b> для перегляду списку команд',
      '\n\n',
      `✌️ Created by <a href=\"${'https://t.me/baklai'}\">Dmitrii Baklai</a> © ${new Date().getFullYear()}.`
    ];

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '💸 DONATE FOR BOT',
              url: this.configService.get<string>('DONATE_URI')
            }
          ]
        ]
      }
    });
  }

  private async handlerCommandStatistic(ctx: TContext) {
    const [usersCount, productsCount] = await Promise.all([
      this.userModel.countDocuments(),
      this.productModel.countDocuments()
    ]);

    const message = [
      `👋👋👋 <b><i>${ctx.userInfo.firstName}</i>, мої вітання</b>!`,
      '\n\n',
      '📊 <b>Статистика додатку:</b>',
      '\n',
      `<i> 🔹 Кількість користувачів: ${usersCount}</i>`,
      '\n',
      // `<i> 🔹 Кількість категорій товарів: ${categoriesCount}</i>`,
      '\n',
      `<i> 🔹 Кількість товарів у категоріях: ${productsCount}</i>`,
      '\n\n',
      '👉 Надішліть <b>/help</b> для перегляду списку команд'
    ];

    await ctx.replyWithHTML(message.join(''), {
      link_preview_options: { is_disabled: true },
      reply_markup: {
        resize_keyboard: true,
        keyboard: [
          [
            {
              text: 'Відкрити холодос',
              web_app: { url: this.configService.get<string>('WEB_APP') }
            }
          ],
          [{ text: '❓ Help' }, { text: '💸 Donate' }]
        ]
      }
    });
  }

  private toBase64Img(img: string) {
    if (!img) return 'data:image/svg+xml;base64';
    return `data:image/svg+xml;base64,${img}`;
  }

  private bufferToBase64Img(img: any) {
    if (!img) return 'data:image/webp;base64';
    return `data:image/webp;base64,${img.toString('base64')}`;
  }

  statusTelegramBot(processUpdate: Record<string, any>): Record<string, any> {
    return processUpdate;
  }

  async findOneUser(userID: number): Promise<User> {
    return await this.userModel.findOne({ userID: userID });
  }

  async findAllCategory(query: Record<string, any>): Promise<Record<string, any>[]> {
    const { market = '' } = query;
    try {
      const categories = await this.productModel.aggregate([
        { $match: { market: market } },
        { $group: { _id: { categoryName: '$categoryName', categoryIcon: '$categoryIcon' } } },
        {
          $project: { categoryName: '$_id.categoryName', categoryIcon: '$_id.categoryIcon', _id: 0 }
        }
      ]);

      return categories.map(category => {
        return { ...category, categoryIcon: this.toBase64Img(category.categoryIcon) };
      });
    } catch (err) {
      throw new Error(err.message);
    }
  }

  async findAllProduct(query: Record<string, any>): Promise<Record<string, any>[]> {
    const { market = '', category = '' } = query;
    try {
      const products = await this.productModel
        .find({ market: market, categoryName: category })
        .select({
          _id: 1,
          title: 1,
          img: 1,
          pricePer: 1,
          priceTitle: 1,
          market: 1,
          categoryName: 1
        })
        .lean()
        .exec();

      return products.map(product => {
        return {
          id: product._id,
          title: product.title,
          img: this.bufferToBase64Img(product.img),
          pricePer: product.pricePer,
          priceTitle: product.priceTitle,
          market: product.market,
          categoryName: product.categoryName
        };
      });
    } catch (err) {
      throw new Error(err.message);
    }
  }
}
